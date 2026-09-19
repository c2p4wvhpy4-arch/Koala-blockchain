const express =
  require("express");

const crypto =
  require("crypto");

const path =
  require("path");

const {
  KoalaBlockchain,
  Transaction
} = require("./blockchain");

const app = express();

const PORT =
  Number(
    process.env.PORT || 3000
  );

app.use(express.json());

app.use(
  express.static(
    path.join(
      __dirname,
      "public"
    )
  )
);

const koala =
  new KoalaBlockchain();

function createAddress() {
  return (
    "KOA_" +
    crypto
      .randomBytes(20)
      .toString("hex")
  );
}

/*
====================================
HEALTH
====================================
*/

app.get(
  "/health",
  (req, res) => {
    res.json({
      ok: true,
      blockchain:
        koala.name,
      symbol:
        koala.symbol
    });
  }
);

/*
====================================
BLOCKCHAIN INFO
====================================
*/

app.get(
  "/api/info",
  (req, res) => {
    res.json({
      name:
        koala.name,

      symbol:
        koala.symbol,

      blocks:
        koala.chain.length,

      difficulty:
        koala.difficulty,

      miningReward:
        koala.miningReward,

      maxSupply:
        koala.maxSupply,

      totalMined:
        koala.totalMined,

      pendingTransactions:
        koala
          .pendingTransactions
          .length,

      valid:
        koala.isChainValid()
    });
  }
);

/*
====================================
BLOCKS
====================================
*/

app.get(
  "/api/blocks",
  (req, res) => {
    res.json(
      koala.chain
    );
  }
);

app.get(
  "/api/blocks/:index",
  (req, res) => {
    const index =
      Number(
        req.params.index
      );

    const block =
      koala.chain[index];

    if (!block) {
      return res
        .status(404)
        .json({
          error:
            "Bloc introuvable."
        });
    }

    res.json(block);
  }
);

/*
====================================
CREATE WALLET
====================================
*/

app.post(
  "/api/wallet",
  (req, res) => {
    const address =
      createAddress();

    res.json({
      address,
      symbol: "KOA",
      balance: 0
    });
  }
);

/*
====================================
BALANCE
====================================
*/

app.get(
  "/api/balance/:address",
  (req, res) => {
    const address =
      req.params.address;

    res.json({
      address,
      symbol:
        koala.symbol,

      balance:
        koala
          .getBalanceOfAddress(
            address
          )
    });
  }
);

/*
====================================
TRANSACTIONS
====================================
*/

app.get(
  "/api/transactions/pending",
  (req, res) => {
    res.json(
      koala.pendingTransactions
    );
  }
);

app.get(
  "/api/transactions/:address",
  (req, res) => {
    res.json(
      koala
        .getTransactionsForAddress(
          req.params.address
        )
    );
  }
);

app.post(
  "/api/transactions",
  (req, res) => {
    try {
      const {
        fromAddress,
        toAddress,
        amount
      } = req.body;

      const transaction =
        new Transaction(
          fromAddress,
          toAddress,
          Number(amount)
        );

      koala
        .createTransaction(
          transaction
        );

      res.status(201).json({
        success: true,
        message:
          "Transaction ajoutée.",
        transaction
      });

    } catch (error) {
      res
        .status(400)
        .json({
          success: false,
          error:
            error.message
        });
    }
  }
);

/*
====================================
MINING
====================================
*/

app.post(
  "/api/mine",
  (req, res) => {
    try {
      const {
        minerAddress
      } = req.body;

      const result =
        koala
          .minePendingTransactions(
            minerAddress
          );

      res.json({
        success: true,

        message:
          "Nouveau bloc KOA créé.",

        reward:
          result.reward,

        block:
          result.block
      });

    } catch (error) {
      res
        .status(400)
        .json({
          success: false,
          error:
            error.message
        });
    }
  }
);

/*
====================================
VALIDATION
====================================
*/

app.get(
  "/api/validate",
  (req, res) => {
    res.json({
      valid:
        koala.isChainValid()
    });
  }
);

/*
====================================
START
====================================
*/

app.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log(
      "=================================="
    );

    console.log(
      "KOALA BLOCKCHAIN"
    );

    console.log(
      "Monnaie native : KOA"
    );

    console.log(
      `Port : ${PORT}`
    );

    console.log(
      "=================================="
    );
  }
);