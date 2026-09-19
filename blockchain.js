const crypto = require("crypto");

class Transaction {
  constructor(fromAddress, toAddress, amount) {
    this.fromAddress = fromAddress;
    this.toAddress = toAddress;
    this.amount = Number(amount);
    this.timestamp = Date.now();
  }
}

class Block {
  constructor(index, timestamp, transactions, previousHash = "") {
    this.index = index;
    this.timestamp = timestamp;
    this.transactions = transactions;
    this.previousHash = previousHash;

    this.nonce = 0;
    this.hash = this.calculateHash();
  }

  calculateHash() {
    return crypto
      .createHash("sha256")
      .update(
        this.index +
          this.previousHash +
          this.timestamp +
          JSON.stringify(this.transactions) +
          this.nonce
      )
      .digest("hex");
  }

  mineBlock(difficulty) {
    const target = Array(difficulty + 1).join("0");

    while (
      this.hash.substring(0, difficulty) !== target
    ) {
      this.nonce++;
      this.hash = this.calculateHash();
    }

    console.log(
      `Bloc #${this.index} miné : ${this.hash}`
    );
  }
}

class KoalaBlockchain {
  constructor() {
    this.name = "Koala Blockchain";
    this.symbol = "KOA";

    this.chain = [
      this.createGenesisBlock()
    ];

    this.difficulty = 3;

    this.pendingTransactions = [];

    this.miningReward = 50;

    this.maxSupply = 21000000;

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
    if (!transaction.toAddress) {
      throw new Error(
        "Adresse destinataire obligatoire."
      );
    }

    if (
      !Number.isFinite(transaction.amount) ||
      transaction.amount <= 0
    ) {
      throw new Error(
        "Montant invalide."
      );
    }

    if (transaction.fromAddress) {
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
            (sum, tx) =>
              sum + Number(tx.amount),
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
        "La quantité maximale de KOA a été atteinte."
      );
    }

    const block =
      new Block(
        this.chain.length,
        Date.now(),
        this.pendingTransactions,
        this.getLatestBlock().hash
      );

    block.mineBlock(
      this.difficulty
    );

    this.chain.push(block);

    const reward =
      Math.min(
        this.miningReward,
        this.maxSupply -
          this.totalMined
      );

    this.totalMined += reward;

    this.pendingTransactions = [
      new Transaction(
        null,
        minerAddress,
        reward
      )
    ];

    return {
      block,
      reward
    };
  }

  getBalanceOfAddress(address) {
    let balance = 0;

    for (const block of this.chain) {
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

    for (const block of this.chain) {
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
    }

    return true;
  }
}

module.exports = {
  KoalaBlockchain,
  Transaction
};