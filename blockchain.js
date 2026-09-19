const crypto = require("crypto");

// ============================================================
// OUTILS
// ============================================================

function sha256(data) {
  return crypto
    .createHash("sha256")
    .update(String(data))
    .digest("hex");
}

function isHex(value) {
  return (
    typeof value === "string" &&
    /^[0-9a-fA-F]+$/.test(value)
  );
}

// ============================================================
// SÉRIALISATION DÉTERMINISTE
//
// IMPORTANT :
// PostgreSQL JSONB peut restituer les propriétés JSON dans un
// ordre différent.
//
// On ne dépend donc plus de l'ordre des propriétés d'un objet.
// ============================================================

function canonicalTransaction(transaction) {
  return {
    fromAddress:
      transaction.fromAddress === undefined
        ? null
        : transaction.fromAddress,

    toAddress:
      transaction.toAddress === undefined
        ? null
        : transaction.toAddress,

    amount:
      Number(transaction.amount),

    publicKey:
      transaction.publicKey === undefined
        ? null
        : transaction.publicKey,

    timestamp:
      Number(transaction.timestamp),

    signature:
      transaction.signature === undefined
        ? null
        : transaction.signature
  };
}

function canonicalTransactions(transactions) {
  if (!Array.isArray(transactions)) {
    return [];
  }

  return transactions.map(
    transaction =>
      canonicalTransaction(
        transaction
      )
  );
}

function serializeTransactions(transactions) {
  return JSON.stringify(
    canonicalTransactions(
      transactions
    )
  );
}

// ============================================================
// CLÉ PUBLIQUE
// ============================================================

function normalizePublicKey(publicKey) {
  if (
    typeof publicKey !== "string" ||
    !publicKey.trim()
  ) {
    throw new Error(
      "Clé publique invalide."
    );
  }

  const key =
    publicKey.trim();

  // Ancien format PEM
  if (
    key.includes(
      "BEGIN PUBLIC KEY"
    )
  ) {
    return key;
  }

  // Nouveau format secp256k1 hex
  if (!isHex(key)) {
    throw new Error(
      "Format de clé publique invalide."
    );
  }

  /*
    secp256k1 :

    33 octets compressés = 66 caractères hex
    65 octets non compressés = 130 caractères hex
  */

  if (
    key.length !== 66 &&
    key.length !== 130
  ) {
    throw new Error(
      "Longueur de clé publique secp256k1 invalide."
    );
  }

  return key.toLowerCase();
}

// ============================================================
// ADRESSE KOA
// ============================================================

function addressFromPublicKey(
  publicKey
) {
  const normalized =
    normalizePublicKey(
      publicKey
    );

  return (
    "KOA_" +
    sha256(normalized)
      .substring(
        0,
        40
      )
  );
}

// ============================================================
// CONVERSION CLÉ HEX -> KEYOBJECT NODE
// ============================================================

function publicKeyHexToKeyObject(
  publicKeyHex
) {
  const normalized =
    normalizePublicKey(
      publicKeyHex
    );

  if (
    normalized.includes(
      "BEGIN PUBLIC KEY"
    )
  ) {
    return crypto
      .createPublicKey(
        normalized
      );
  }

  const uncompressed =
    crypto.ECDH.convertKey(
      Buffer.from(
        normalized,
        "hex"
      ),
      "secp256k1",
      undefined,
      undefined,
      "uncompressed"
    );

  const spkiPrefix =
    Buffer.from(
      "3056301006072a8648ce3d020106052b8104000a034200",
      "hex"
    );

  const der =
    Buffer.concat([
      spkiPrefix,
      uncompressed
    ]);

  return crypto.createPublicKey({
    key: der,
    format: "der",
    type: "spki"
  });
}

// ============================================================
// PORTEFEUILLE
// ============================================================

function createWallet() {
  const {
    publicKey,
    privateKey
  } =
    crypto.generateKeyPairSync(
      "ec",
      {
        namedCurve:
          "secp256k1",

        publicKeyEncoding: {
          type:
            "spki",

          format:
            "pem"
        },

        privateKeyEncoding: {
          type:
            "pkcs8",

          format:
            "pem"
        }
      }
    );

  return {
    address:
      addressFromPublicKey(
        publicKey
      ),

    publicKey,

    privateKey
  };
}

// ============================================================
// TRANSACTION
// ============================================================

class Transaction {
  constructor(
    fromAddress,
    toAddress,
    amount,
    publicKey = null
  ) {
    this.fromAddress =
      fromAddress;

    this.toAddress =
      toAddress;

    this.amount =
      Number(amount);

    this.publicKey =
      publicKey;

    this.timestamp =
      Date.now();

    this.signature =
      null;
  }

  // ==========================================================
  // HASH DE TRANSACTION
  // ==========================================================

  calculateHash() {
    return sha256(
      String(
        this.fromAddress
      ) +
      String(
        this.toAddress
      ) +
      String(
        this.amount
      ) +
      String(
        this.timestamp
      )
    );
  }

  // ==========================================================
  // SIGNATURE
  // ==========================================================

  signTransaction(
    privateKey
  ) {
    if (
      !this.fromAddress
    ) {
      throw new Error(
        "Une récompense minière ne doit pas être signée."
      );
    }

    if (
      !this.publicKey
    ) {
      throw new Error(
        "Clé publique manquante."
      );
    }

    const expectedAddress =
      addressFromPublicKey(
        this.publicKey
      );

    if (
      expectedAddress !==
      this.fromAddress
    ) {
      throw new Error(
        "La clé publique ne correspond pas à l'adresse."
      );
    }

    const signature =
      crypto.sign(
        "sha256",

        Buffer.from(
          this.calculateHash()
        ),

        privateKey
      );

    this.signature =
      signature.toString(
        "hex"
      );

    return this.signature;
  }

  // ==========================================================
  // VALIDATION TRANSACTION
  // ==========================================================

  isValid() {
    /*
      Récompense minière :
      pas d'expéditeur et pas de signature.
    */

    if (
      this.fromAddress === null
    ) {
      return (
        typeof this.toAddress ===
          "string" &&
        this.toAddress.length > 0 &&
        Number.isFinite(
          Number(this.amount)
        ) &&
        Number(this.amount) > 0
      );
    }

    if (
      !this.signature ||
      !this.publicKey
    ) {
      return false;
    }

    let expectedAddress;

    try {
      expectedAddress =
        addressFromPublicKey(
          this.publicKey
        );
    } catch {
      return false;
    }

    if (
      expectedAddress !==
      this.fromAddress
    ) {
      return false;
    }

    try {
      let publicKeyObject;

      if (
        this.publicKey.includes(
          "BEGIN PUBLIC KEY"
        )
      ) {
        publicKeyObject =
          this.publicKey;
      } else {
        publicKeyObject =
          publicKeyHexToKeyObject(
            this.publicKey
          );
      }

      return crypto.verify(
        "sha256",

        Buffer.from(
          this.calculateHash()
        ),

        publicKeyObject,

        Buffer.from(
          this.signature,
          "hex"
        )
      );

    } catch (
      error
    ) {
      console.error(
        "Erreur vérification signature :",
        error.message
      );

      return false;
    }
  }
}

// ============================================================
// BLOC
// ============================================================

class Block {
  constructor(
    index,
    timestamp,
    transactions,
    previousHash = ""
  ) {
    this.index =
      Number(index);

    this.timestamp =
      Number(timestamp);

    this.transactions =
      canonicalTransactions(
        transactions
      );

    this.previousHash =
      previousHash;

    this.nonce =
      0;

    this.hash =
      this.calculateHash();
  }

  // ==========================================================
  // HASH DÉTERMINISTE
  // ==========================================================

  calculateHash() {
    return sha256(
      String(this.index) +
      String(this.previousHash) +
      String(this.timestamp) +
      serializeTransactions(
        this.transactions
      ) +
      String(this.nonce)
    );
  }

  // ==========================================================
  // MINAGE
  // ==========================================================

  mineBlock(
    difficulty
  ) {
    const target =
      "0".repeat(
        difficulty
      );

    while (
      this.hash.substring(
        0,
        difficulty
      ) !== target
    ) {
      this.nonce++;

      this.hash =
        this.calculateHash();
    }

    console.log(
      `Bloc #${this.index} miné : ${this.hash}`
    );
  }

  // ==========================================================
  // VALIDATION DES TRANSACTIONS
  // ==========================================================

  hasValidTransactions() {
    return this
      .transactions
      .every(
        transaction => {
          const tx =
            Object.assign(
              new Transaction(),
              transaction
            );

          return tx.isValid();
        }
      );
  }
}

// ============================================================
// KOALA BLOCKCHAIN
// ============================================================

class KoalaBlockchain {
  constructor() {
    this.name =
      "Koala Blockchain";

    this.symbol =
      "KOA";

    this.chain = [
      this.createGenesisBlock()
    ];

    this.difficulty =
      3;

    this.pendingTransactions =
      [];

    this.miningReward =
      50;

    this.maxSupply =
      21000000;

    this.totalMined =
      0;
  }

  // ==========================================================
  // GENESIS
  // ==========================================================

  createGenesisBlock() {
    return new Block(
      0,
      Date.now(),
      [],
      "0"
    );
  }

  getLatestBlock() {
    return this.chain[
      this.chain.length - 1
    ];
  }

  // ==========================================================
  // TRANSACTION
  // ==========================================================

  createTransaction(
    transaction
  ) {
    if (
      !transaction.fromAddress ||
      !transaction.toAddress
    ) {
      throw new Error(
        "Adresse expéditeur et destinataire obligatoires."
      );
    }

    if (
      !Number.isFinite(
        Number(
          transaction.amount
        )
      ) ||
      Number(
        transaction.amount
      ) <= 0
    ) {
      throw new Error(
        "Montant invalide."
      );
    }

    transaction.amount =
      Number(
        transaction.amount
      );

    if (
      !transaction.isValid()
    ) {
      throw new Error(
        "Signature de transaction invalide."
      );
    }

    const balance =
      this.getBalanceOfAddress(
        transaction.fromAddress
      );

    const pending =
      this.pendingTransactions
        .filter(
          tx =>
            tx.fromAddress ===
            transaction.fromAddress
        )
        .reduce(
          (
            total,
            tx
          ) =>
            total +
            Number(
              tx.amount
            ),
          0
        );

    if (
      balance - pending <
      transaction.amount
    ) {
      throw new Error(
        "Solde KOA insuffisant."
      );
    }

    this.pendingTransactions.push(
      transaction
    );

    return transaction;
  }

  // ==========================================================
  // MINAGE
  // ==========================================================

  minePendingTransactions(
    minerAddress
  ) {
    if (
      !minerAddress ||
      typeof minerAddress !==
        "string"
    ) {
      throw new Error(
        "Adresse du mineur obligatoire."
      );
    }

    if (
      this.totalMined >=
      this.maxSupply
    ) {
      throw new Error(
        "Quantité maximale de KOA atteinte."
      );
    }

    const reward =
      Math.min(
        this.miningReward,

        this.maxSupply -
          this.totalMined
      );

    const rewardTransaction =
      new Transaction(
        null,
        minerAddress,
        reward
      );

    const transactions = [
      ...this.pendingTransactions,
      rewardTransaction
    ];

    const block =
      new Block(
        this.chain.length,
        Date.now(),
        transactions,
        this.getLatestBlock()
          .hash
      );

    block.mineBlock(
      this.difficulty
    );

    this.chain.push(
      block
    );

    this.totalMined +=
      reward;

    this.pendingTransactions =
      [];

    return {
      block,
      reward
    };
  }

  // ==========================================================
  // SOLDE
  // ==========================================================

  getBalanceOfAddress(
    address
  ) {
    let balance =
      0;

    for (
      const block
      of this.chain
    ) {
      for (
        const transaction
        of block.transactions
      ) {
        if (
          transaction.fromAddress ===
          address
        ) {
          balance -=
            Number(
              transaction.amount
            );
        }

        if (
          transaction.toAddress ===
          address
        ) {
          balance +=
            Number(
              transaction.amount
            );
        }
      }
    }

    return balance;
  }

  // ==========================================================
  // HISTORIQUE
  // ==========================================================

  getTransactionsForAddress(
    address
  ) {
    const transactions =
      [];

    for (
      const block
      of this.chain
    ) {
      for (
        const transaction
        of block.transactions
      ) {
        if (
          transaction.fromAddress ===
            address ||
          transaction.toAddress ===
            address
        ) {
          transactions.push({
            block:
              block.index,

            ...transaction
          });
        }
      }
    }

    return transactions;
  }

  // ==========================================================
  // VALIDATION BLOCKCHAIN
  // ==========================================================

  isChainValid() {
    if (
      !Array.isArray(
        this.chain
      ) ||
      this.chain.length === 0
    ) {
      console.error(
        "Blockchain vide."
      );

      return false;
    }

    for (
      let i = 1;
      i < this.chain.length;
      i++
    ) {
      const currentBlock =
        this.chain[i];

      const previousBlock =
        this.chain[
          i - 1
        ];

      const recalculatedHash =
        currentBlock
          .calculateHash();

      if (
        currentBlock.hash !==
        recalculatedHash
      ) {
        console.error(
          `Bloc #${currentBlock.index} : hash invalide`
        );

        console.error(
          "Hash enregistré :",
          currentBlock.hash
        );

        console.error(
          "Hash recalculé :",
          recalculatedHash
        );

        return false;
      }

      if (
        currentBlock.previousHash !==
        previousBlock.hash
      ) {
        console.error(
          `Bloc #${currentBlock.index} : previousHash invalide`
        );

        console.error(
          "PreviousHash enregistré :",
          currentBlock.previousHash
        );

        console.error(
          "Hash bloc précédent :",
          previousBlock.hash
        );

        return false;
      }

      if (
        !currentBlock
          .hasValidTransactions()
      ) {
        console.error(
          `Bloc #${currentBlock.index} : transaction invalide`
        );

        return false;
      }
    }

    console.log(
      "Validation blockchain : OK"
    );

    return true;
  }
}

// ============================================================
// EXPORTS
// ============================================================

module.exports = {
  KoalaBlockchain,
  Transaction,
  Block,
  createWallet,
  addressFromPublicKey,
  publicKeyHexToKeyObject,
  canonicalTransaction,
  canonicalTransactions,
  serializeTransactions
};