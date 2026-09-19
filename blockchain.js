const crypto = require("crypto");

// ============================================================
// OUTILS
// ============================================================

function sha256(data) {
  return crypto
    .createHash("sha256")
    .update(data)
    .digest("hex");
}

function isHex(value) {
  return (
    typeof value === "string" &&
    /^[0-9a-fA-F]+$/.test(value)
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

  /*
    Node peut convertir directement
    une clé EC brute grâce à
    ECDH.convertKey.

    On la convertit d'abord en
    clé non compressée.
  */

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

  /*
    Structure SPKI DER pour secp256k1.

    Préfixe :
    3056301006072a8648ce3d020106052b8104000a034200

    Puis clé publique non compressée
    de 65 octets.
  */

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
// PORTEFEUILLE SERVEUR
//
// Conservé temporairement pour compatibilité.
// Le nouveau portefeuille sera créé côté appareil.
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

  // ----------------------------------------------------------
  // HASH À SIGNER
  // ----------------------------------------------------------

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

  // ----------------------------------------------------------
  // SIGNATURE SERVEUR
  //
  // Conservée uniquement pour compatibilité/tests.
  // Le nouveau navigateur ne l'utilisera pas.
  // ----------------------------------------------------------

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

  // ----------------------------------------------------------
  // VALIDATION
  // ----------------------------------------------------------

  isValid() {
    /*
      Une récompense minière
      n'a pas d'expéditeur.
    */

    if (
      this.fromAddress === null
    ) {
      return true;
    }

    if (
      !this.signature ||
      !this.publicKey
    ) {
      return false;
    }

    // Vérifie que la clé appartient
    // bien à l'adresse KOA.

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

      // Ancienne clé PEM
      if (
        this.publicKey.includes(
          "BEGIN PUBLIC KEY"
        )
      ) {
        publicKeyObject =
          this.publicKey;
      }

      // Nouvelle clé hex secp256k1
      else {
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
      index;

    this.timestamp =
      timestamp;

    this.transactions =
      transactions;

    this.previousHash =
      previousHash;

    this.nonce =
      0;

    this.hash =
      this.calculateHash();
  }

  calculateHash() {
    return sha256(
      this.index +
      this.previousHash +
      this.timestamp +
      JSON.stringify(
        this.transactions
      ) +
      this.nonce
    );
  }

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
        transaction.amount
      ) ||
      transaction.amount <= 0
    ) {
      throw new Error(
        "Montant invalide."
      );
    }

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
      !minerAddress
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
    for (
      let i = 1;
      i <
      this.chain.length;
      i++
    ) {
      const currentBlock =
        this.chain[i];

      const previousBlock =
        this.chain[
          i - 1
        ];

      if (
        currentBlock.hash !==
        currentBlock.calculateHash()
      ) {
        return false;
      }

      if (
        currentBlock.previousHash !==
        previousBlock.hash
      ) {
        return false;
      }

      if (
        !currentBlock
          .hasValidTransactions()
      ) {
        return false;
      }
    }

    return true;
  }
}

// ============================================================
// EXPORTS
// ============================================================

module.exports = {
  KoalaBlockchain,
  Transaction,
  createWallet,
  addressFromPublicKey,
  publicKeyHexToKeyObject
};