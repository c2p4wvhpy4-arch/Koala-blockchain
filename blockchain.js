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
      canonicalTransaction(transaction)
  );
}

function serializeTransactions(transactions) {
  return JSON.stringify(
    canonicalTransactions(transactions)
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
  // VALIDATION
  // ==========================================================

  isValid() {
    if (
      !Number.isFinite(
        Number(this.amount)
      ) ||
      Number(this.amount) <= 0
    ) {
      return false;
    }

    if (
      typeof this.toAddress !==
        "string" ||
      !this.toAddress
    ) {
      return false;
    }

    // --------------------------------------------------------
    // RÉCOMPENSE MINIÈRE
    // --------------------------------------------------------

    if (
      this.fromAddress === null
    ) {
      return (
        !this.publicKey &&
        !this.signature
      );
    }

    // --------------------------------------------------------
    // TRANSACTION NORMALE
    // --------------------------------------------------------

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

    } catch (error) {
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
  // VALIDATION COMPLÈTE DE LA BLOCKCHAIN
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

    const genesis =
      this.chain[0];

    // --------------------------------------------------------
    // GENESIS
    // --------------------------------------------------------

    if (
      genesis.index !== 0 ||
      genesis.previousHash !==
        "0"
    ) {
      console.error(
        "Bloc Genesis invalide."
      );

      return false;
    }

    if (
      genesis.hash !==
      genesis.calculateHash()
    ) {
      console.error(
        "Hash du bloc Genesis invalide."
      );

      return false;
    }

    if (
      genesis.transactions.length !==
      0
    ) {
      console.error(
        "Le bloc Genesis contient des transactions."
      );

      return false;
    }

    // Soldes reconstruits uniquement depuis
    // la blockchain validée.

    const balances =
      new Map();

    let totalMined =
      0;

    const target =
      "0".repeat(
        this.difficulty
      );

    // --------------------------------------------------------
    // BLOCS
    // --------------------------------------------------------

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

      // ------------------------------------------------------
      // INDEX
      // ------------------------------------------------------

      if (
        currentBlock.index !==
        i
      ) {
        console.error(
          `Bloc #${i} : index invalide`
        );

        return false;
      }

      // ------------------------------------------------------
      // HASH
      // ------------------------------------------------------

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

        return false;
      }

      // ------------------------------------------------------
      // PREVIOUS HASH
      // ------------------------------------------------------

      if (
        currentBlock.previousHash !==
        previousBlock.hash
      ) {
        console.error(
          `Bloc #${currentBlock.index} : previousHash invalide`
        );

        return false;
      }

      // ------------------------------------------------------
      // PROOF OF WORK
      // ------------------------------------------------------

      if (
        !currentBlock.hash.startsWith(
          target
        )
      ) {
        console.error(
          `Bloc #${currentBlock.index} : preuve de travail invalide`
        );

        return false;
      }

      // ------------------------------------------------------
      // TRANSACTIONS
      // ------------------------------------------------------

      if (
        !Array.isArray(
          currentBlock.transactions
        )
      ) {
        return false;
      }

      let rewardCount =
        0;

      for (
        let txIndex = 0;
        txIndex <
        currentBlock.transactions.length;
        txIndex++
      ) {
        const rawTransaction =
          currentBlock.transactions[
            txIndex
          ];

        const transaction =
          Object.assign(
            new Transaction(),
            rawTransaction
          );

        if (
          !transaction.isValid()
        ) {
          console.error(
            `Bloc #${currentBlock.index} : transaction invalide`
          );

          return false;
        }

        // ----------------------------------------------------
        // RÉCOMPENSE MINIÈRE
        // ----------------------------------------------------

        if (
          transaction.fromAddress ===
          null
        ) {
          rewardCount++;

          // Une seule récompense par bloc.

          if (
            rewardCount > 1
          ) {
            console.error(
              `Bloc #${currentBlock.index} : plusieurs récompenses minières`
            );

            return false;
          }

          // La récompense doit être la dernière
          // transaction du bloc.

          if (
            txIndex !==
            currentBlock.transactions.length -
              1
          ) {
            console.error(
              `Bloc #${currentBlock.index} : récompense mal positionnée`
            );

            return false;
          }

          const remainingSupply =
            this.maxSupply -
            totalMined;

          const expectedReward =
            Math.min(
              this.miningReward,
              remainingSupply
            );

          if (
            Number(
              transaction.amount
            ) !==
            expectedReward
          ) {
            console.error(
              `Bloc #${currentBlock.index} : récompense minière invalide`
            );

            return false;
          }

          totalMined +=
            Number(
              transaction.amount
            );

          if (
            totalMined >
            this.maxSupply
          ) {
            console.error(
              "MAX SUPPLY KOA dépassée."
            );

            return false;
          }

          const minerBalance =
            balances.get(
              transaction.toAddress
            ) || 0;

          balances.set(
            transaction.toAddress,
            minerBalance +
              Number(
                transaction.amount
              )
          );

          continue;
        }

        // ----------------------------------------------------
        // TRANSACTION NORMALE
        // ----------------------------------------------------

        const amount =
          Number(
            transaction.amount
          );

        const senderBalance =
          balances.get(
            transaction.fromAddress
          ) || 0;

        if (
          senderBalance <
          amount
        ) {
          console.error(
            `Bloc #${currentBlock.index} : double dépense ou solde insuffisant`
          );

          return false;
        }

        balances.set(
          transaction.fromAddress,
          senderBalance -
            amount
        );

        const receiverBalance =
          balances.get(
            transaction.toAddress
          ) || 0;

        balances.set(
          transaction.toAddress,
          receiverBalance +
            amount
        );
      }

      // ------------------------------------------------------
      // EXACTEMENT UNE RÉCOMPENSE PAR BLOC MINÉ
      // ------------------------------------------------------

      if (
        rewardCount !== 1
      ) {
        console.error(
          `Bloc #${currentBlock.index} : récompense minière manquante`
        );

        return false;
      }
    }

    console.log(
      "Validation blockchain renforcée : OK"
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