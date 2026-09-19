const crypto = require("crypto");

// ============================================================
// OUTILS CRYPTOGRAPHIQUES
// ============================================================

function sha256(data) {
  return crypto
    .createHash("sha256")
    .update(data)
    .digest("hex");
}

function addressFromPublicKey(publicKey) {
  return "KOA_" + sha256(publicKey).substring(0, 40);
}

// ============================================================
// PORTEFEUILLE
// ============================================================

function createWallet() {
  const {
    publicKey,
    privateKey
  } = crypto.generateKeyPairSync("ec", {
    namedCurve: "secp256k1",
    publicKeyEncoding: {
      type: "spki",
      format: "pem"
    },
    privateKeyEncoding: {
      type: "pkcs8",
      format: "pem"
    }
  });

  return {
    address: addressFromPublicKey(publicKey),
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
    this.fromAddress = fromAddress;
    this.toAddress = toAddress;
    this.amount = Number(amount);
    this.publicKey = publicKey;
    this.timestamp = Date.now();
    this.signature = null;
  }

  calculateHash() {
    return sha256(
      String(this.fromAddress) +
      String(this.toAddress) +
      String(this.amount) +
      String(this.timestamp)
    );
  }

  signTransaction(privateKey) {
    if (!this.fromAddress) {
      throw new Error(
        "Une récompense minière ne doit pas être signée."
      );
    }

    if (!this.publicKey) {
      throw new Error(
        "Clé publique manquante."
      );
    }

    const expectedAddress =
      addressFromPublicKey(this.publicKey);

    if (expectedAddress !== this.fromAddress) {
      throw new Error(
        "La clé publique ne correspond pas à l'adresse."
      );
    }

    const signature = crypto.sign(
      "sha256",
      Buffer.from(this.calculateHash()),
      privateKey
    );

    this.signature =
      signature.toString("hex");

    return this.signature;
  }

  isValid() {
    // Récompense du réseau
    if (this.fromAddress === null) {
      return true;
    }

    if (
      !this.signature ||
      !this.publicKey
    ) {
      return false;
    }

    if (
      addressFromPublicKey(this.publicKey) !==
      this.fromAddress
    ) {
      return false;
    }

    try {
      return crypto.verify(
        "sha256",
        Buffer.from(this.calculateHash()),
        this.publicKey,
        Buffer.from(
          this.signature,
          "hex"
        )
      );
    } catch {
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
    this.index = index;
    this.timestamp = timestamp;
    this.transactions = transactions;
    this.previousHash = previousHash;

    this.nonce = 0;
    this.hash = this.calculateHash();
  }

  calculateHash() {
    return sha256(
      this.index +
      this.previousHash +
      this.timestamp +
      JSON.stringify(this.transactions) +
      this.nonce
    );
  }

  mineBlock(difficulty) {
    const target =
      "0".repeat(difficulty);

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
    return this.transactions.every(
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
// BLOCKCHAIN KOALA
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

    this.difficulty = 3;

    this.pendingTransactions = [];

    this.miningReward = 50;

    this.maxSupply =
      21000000;

    this.totalMined = 0;
  }

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

  createTransaction(transaction) {
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

    if (!transaction.isValid()) {
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
          (total, tx) =>
            total +
            Number(tx.amount),
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

  minePendingTransactions(
    minerAddress
  ) {
    if (!minerAddress) {
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

    // La récompense est incluse directement
    // dans le bloc qui vient d'être miné.
    const rewardTransaction =
      new Transaction(
        null,
        minerAddress,
        reward
      );

    const transactions =
      [
        ...this.pendingTransactions,
        rewardTransaction
      ];

    const block =
      new Block(
        this.chain.length,
        Date.now(),
        transactions,
        this.getLatestBlock().hash
      );

    block.mineBlock(
      this.difficulty
    );

    this.chain.push(block);

    this.totalMined += reward;

    this.pendingTransactions = [];

    return {
      block,
      reward
    };
  }

  getBalanceOfAddress(address) {
    let balance = 0;

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

  getTransactionsForAddress(
    address
  ) {
    const transactions = [];

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

  isChainValid() {
    for (
      let i = 1;
      i < this.chain.length;
      i++
    ) {
      const currentBlock =
        this.chain[i];

      const previousBlock =
        this.chain[i - 1];

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

module.exports = {
  KoalaBlockchain,
  Transaction,
  createWallet,
  addressFromPublicKey
};