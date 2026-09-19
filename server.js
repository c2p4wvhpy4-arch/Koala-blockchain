const express = require("express");
const path = require("path");
const crypto = require("crypto");
const { Pool } = require("pg");

const {
  KoalaBlockchain,
  Transaction,
  createWallet
} = require("./blockchain");

const app = express();

const PORT = Number(process.env.PORT || 3000);
const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.error("DATABASE_URL non configurée.");
  process.exit(1);
}

app.use(express.json());

// ============================================================
// FICHIERS PUBLICS
// ============================================================

app.use(
  express.static(
    path.join(__dirname, "public")
  )
);

// ============================================================
// BIBLIOTHÈQUE SECP256K1 CÔTÉ NAVIGATEUR
// ============================================================

app.get(
  "/vendor/secp256k1.js",
  (req, res) => {
    res.sendFile(
      path.join(
        __dirname,
        "node_modules",
        "@noble",
        "secp256k1",
        "index.js"
      ),
      error => {
        if (error) {
          console.error(
            "Erreur chargement secp256k1 :",
            error.message
          );

          if (!res.headersSent) {
            res
              .status(404)
              .send(
                "Bibliothèque secp256k1 introuvable."
              );
          }
        }
      }
    );
  }
);

// ============================================================
// POSTGRESQL
// ============================================================

const pool = new Pool({
  connectionString: DATABASE_URL,

  ssl:
    process.env.NODE_ENV === "production"
      ? {
          rejectUnauthorized: false
        }
      : false
});

const koala =
  new KoalaBlockchain();

let databaseReady = false;

// ============================================================
// CRÉATION DES TABLES KOALA
// ============================================================

async function createTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS koa_blocks (
      id BIGSERIAL PRIMARY KEY,
      block_index INTEGER UNIQUE NOT NULL,
      timestamp BIGINT NOT NULL,
      previous_hash TEXT NOT NULL,
      hash TEXT UNIQUE NOT NULL,
      nonce BIGINT NOT NULL,
      transactions JSONB NOT NULL DEFAULT '[]'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS koa_transactions (
      id BIGSERIAL PRIMARY KEY,
      block_index INTEGER,
      from_address TEXT,
      to_address TEXT NOT NULL,
      amount NUMERIC(30, 8) NOT NULL,
      public_key TEXT,
      signature TEXT,
      tx_timestamp BIGINT NOT NULL,
      status TEXT NOT NULL DEFAULT 'confirmed',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS
    koa_transactions_from_address_idx
    ON koa_transactions(from_address);
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS
    koa_transactions_to_address_idx
    ON koa_transactions(to_address);
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS koa_state (
      key TEXT PRIMARY KEY,
      value JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  console.log(
    "Tables PostgreSQL KOA : OK"
  );
}

// ============================================================
// SAUVEGARDE ÉTAT
// ============================================================

async function saveState(
  client = pool
) {
  await client.query(
    `
    INSERT INTO koa_state (
      key,
      value,
      updated_at
    )
    VALUES (
      'blockchain',
      $1::jsonb,
      NOW()
    )
    ON CONFLICT (key)
    DO UPDATE SET
      value = EXCLUDED.value,
      updated_at = NOW()
    `,
    [
      JSON.stringify({
        totalMined:
          koala.totalMined,

        pendingTransactions:
          koala.pendingTransactions
      })
    ]
  );
}

// ============================================================
// SAUVEGARDE D'UN BLOC
// ============================================================

async function saveBlock(
  block
) {
  const client =
    await pool.connect();

  try {
    await client.query(
      "BEGIN"
    );

    const insertedBlock =
      await client.query(
        `
        INSERT INTO koa_blocks (
          block_index,
          timestamp,
          previous_hash,
          hash,
          nonce,
          transactions
        )
        VALUES (
          $1,
          $2,
          $3,
          $4,
          $5,
          $6::jsonb
        )
        ON CONFLICT (block_index)
        DO NOTHING
        RETURNING block_index
        `,
        [
          block.index,
          block.timestamp,
          block.previousHash,
          block.hash,
          block.nonce,

          JSON.stringify(
            block.transactions
          )
        ]
      );

    /*
      Les transactions ne sont ajoutées
      que si le bloc vient réellement
      d'être enregistré.
    */

    if (
      insertedBlock.rowCount > 0
    ) {
      for (
        const tx
        of block.transactions
      ) {
        await client.query(
          `
          INSERT INTO koa_transactions (
            block_index,
            from_address,
            to_address,
            amount,
            public_key,
            signature,
            tx_timestamp,
            status
          )
          VALUES (
            $1,
            $2,
            $3,
            $4,
            $5,
            $6,
            $7,
            'confirmed'
          )
          `,
          [
            block.index,
            tx.fromAddress,
            tx.toAddress,
            tx.amount,
            tx.publicKey || null,
            tx.signature || null,
            tx.timestamp
          ]
        );
      }
    }

    await saveState(
      client
    );

    await client.query(
      "COMMIT"
    );

  } catch (error) {
    await client.query(
      "ROLLBACK"
    );

    throw error;

  } finally {
    client.release();
  }
}

// ============================================================
// RESTAURATION BLOCKCHAIN
// ============================================================

async function restoreBlockchain() {
  const result =
    await pool.query(`
      SELECT *
      FROM koa_blocks
      ORDER BY block_index ASC
    `);

  // ----------------------------------------------------------
  // Première installation
  // ----------------------------------------------------------

  if (
    result.rows.length === 0
  ) {
    await saveBlock(
      koala.chain[0]
    );

    await saveState();

    console.log(
      "Bloc Genesis sauvegardé dans PostgreSQL."
    );

    return;
  }

  // ----------------------------------------------------------
  // Reconstruction des blocs
  // ----------------------------------------------------------

  koala.chain =
    result.rows.map(
      row => {
        const transactions =
          Array.isArray(
            row.transactions
          )
            ? row.transactions
            : [];

        return {
          index:
            Number(
              row.block_index
            ),

          timestamp:
            Number(
              row.timestamp
            ),

          transactions,

          previousHash:
            row.previous_hash,

          nonce:
            Number(
              row.nonce
            ),

          hash:
            row.hash,

          calculateHash() {
            return crypto
              .createHash(
                "sha256"
              )
              .update(
                this.index +
                this.previousHash +
                this.timestamp +
                JSON.stringify(
                  this.transactions
                ) +
                this.nonce
              )
              .digest(
                "hex"
              );
          },

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
        };
      }
    );

  // ----------------------------------------------------------
  // Restauration de l'état
  // ----------------------------------------------------------

  const stateResult =
    await pool.query(`
      SELECT value
      FROM koa_state
      WHERE key = 'blockchain'
      LIMIT 1
    `);

  if (
    stateResult.rows.length
  ) {
    const state =
      stateResult
        .rows[0]
        .value || {};

    koala.totalMined =
      Number(
        state.totalMined || 0
      );

    koala.pendingTransactions =
      Array.isArray(
        state.pendingTransactions
      )
        ? state
            .pendingTransactions
            .map(
              transaction =>
                Object.assign(
                  new Transaction(),
                  transaction
                )
            )
        : [];

  } else {
    /*
      Si koa_state n'existe pas,
      on reconstruit le nombre de KOA
      créés à partir des récompenses
      de minage.
    */

    let total = 0;

    for (
      const block
      of koala.chain
    ) {
      for (
        const tx
        of block.transactions
      ) {
        if (
          tx.fromAddress === null
        ) {
          total +=
            Number(
              tx.amount
            );
        }
      }
    }

    koala.totalMined =
      total;

    koala.pendingTransactions =
      [];
  }

  console.log(
    `Blockchain restaurée : ${koala.chain.length} blocs`
  );

  console.log(
    `KOA créés : ${koala.totalMined}`
  );
}

// ============================================================
// HEALTH
// ============================================================

app.get(
  "/health",
  (req, res) => {
    res.json({
      ok: true,

      database:
        databaseReady,

      blockchain:
        koala.name,

      symbol:
        koala.symbol
    });
  }
);

// ============================================================
// BLOCKCHAIN INFO
// ============================================================

app.get(
  "/api/info",
  (req, res) => {
    res.json({
      name:
        koala.name,

      symbol:
        koala.symbol,

      database:
        databaseReady,

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

// ============================================================
// BLOCKS
// ============================================================

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

    res.json(
      block
    );
  }
);

// ============================================================
// CRÉATION WALLET
//
// TEMPORAIRE.
//
// Cette route existe encore pour compatibilité avec
// l'ancienne interface.
//
// La prochaine interface créera le portefeuille
// directement sur l'appareil.
// ============================================================

app.post(
  "/api/wallet",
  (req, res) => {
    try {
      const wallet =
        createWallet();

      res.json({
        success: true,

        symbol:
          "KOA",

        address:
          wallet.address,

        publicKey:
          wallet.publicKey,

        privateKey:
          wallet.privateKey,

        balance:
          0,

        warning:
          "Route temporaire : le portefeuille sera créé localement dans la prochaine interface."
      });

    } catch (error) {
      res
        .status(500)
        .json({
          success: false,

          error:
            error.message
        });
    }
  }
);

// ============================================================
// BALANCE
// ============================================================

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

// ============================================================
// TRANSACTIONS EN ATTENTE
// ============================================================

app.get(
  "/api/transactions/pending",
  (req, res) => {
    res.json(
      koala.pendingTransactions
    );
  }
);

// ============================================================
// TRANSACTIONS D'UNE ADRESSE
// ============================================================

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

// ============================================================
// TRANSACTION SIGNÉE
//
// IMPORTANT :
//
// LA CLÉ PRIVÉE N'EST PAS ACCEPTÉE PAR CETTE ROUTE.
//
// Le client doit envoyer :
//
// fromAddress
// toAddress
// amount
// publicKey
// timestamp
// signature
//
// Le serveur vérifie ensuite la signature.
// ============================================================

app.post(
  "/api/transactions",
  async (req, res) => {
    try {
      const {
        fromAddress,
        toAddress,
        amount,
        publicKey,
        timestamp,
        signature
      } = req.body;

      // ------------------------------------------------------
      // DONNÉES OBLIGATOIRES
      // ------------------------------------------------------

      if (
        !fromAddress ||
        !toAddress ||
        !publicKey ||
        !signature ||
        timestamp === undefined ||
        timestamp === null
      ) {
        return res
          .status(400)
          .json({
            success: false,

            error:
              "Adresse, clé publique, timestamp et signature obligatoires."
          });
      }

      const numericAmount =
        Number(
          amount
        );

      const numericTimestamp =
        Number(
          timestamp
        );

      // ------------------------------------------------------
      // MONTANT
      // ------------------------------------------------------

      if (
        !Number.isFinite(
          numericAmount
        ) ||
        numericAmount <= 0
      ) {
        return res
          .status(400)
          .json({
            success: false,

            error:
              "Montant KOA invalide."
          });
      }

      // ------------------------------------------------------
      // TIMESTAMP
      // ------------------------------------------------------

      if (
        !Number.isSafeInteger(
          numericTimestamp
        ) ||
        numericTimestamp <= 0
      ) {
        return res
          .status(400)
          .json({
            success: false,

            error:
              "Timestamp invalide."
          });
      }

      /*
        Le timestamp doit être proche
        de l'heure actuelle.

        Tolérance : 10 minutes.
      */

      const now =
        Date.now();

      const maxDifference =
        10 * 60 * 1000;

      if (
        Math.abs(
          now -
          numericTimestamp
        ) >
        maxDifference
      ) {
        return res
          .status(400)
          .json({
            success: false,

            error:
              "Timestamp de transaction trop ancien ou trop éloigné."
          });
      }

      // ------------------------------------------------------
      // RECONSTRUCTION DE LA TRANSACTION
      // ------------------------------------------------------

      const transaction =
        new Transaction(
          fromAddress,
          toAddress,
          numericAmount,
          publicKey
        );

      /*
        IMPORTANT :

        On remet exactement le timestamp
        utilisé lors de la signature côté client.
      */

      transaction.timestamp =
        numericTimestamp;

      transaction.signature =
        signature;

      // ------------------------------------------------------
      // VÉRIFICATION CRYPTOGRAPHIQUE
      // ------------------------------------------------------

      if (
        !transaction.isValid()
      ) {
        return res
          .status(400)
          .json({
            success: false,

            error:
              "Signature KOA invalide."
          });
      }

      /*
        createTransaction vérifie ensuite :

        - la signature
        - le montant
        - le solde
        - les transactions déjà en attente
      */

      koala.createTransaction(
        transaction
      );

      // ------------------------------------------------------
      // SAUVEGARDE DE LA TRANSACTION EN ATTENTE
      // ------------------------------------------------------

      await saveState();

      // ------------------------------------------------------
      // RÉPONSE
      // ------------------------------------------------------

      res
        .status(201)
        .json({
          success: true,

          message:
            "Transaction KOA signée vérifiée et ajoutée au prochain bloc.",

          transaction: {
            fromAddress:
              transaction.fromAddress,

            toAddress:
              transaction.toAddress,

            amount:
              transaction.amount,

            timestamp:
              transaction.timestamp,

            publicKey:
              transaction.publicKey,

            signature:
              transaction.signature
          }
        });

    } catch (error) {
      console.error(
        "Erreur transaction KOA :",
        error
      );

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

// ============================================================
// MINING
// ============================================================

app.post(
  "/api/mine",
  async (req, res) => {
    try {
      const {
        minerAddress
      } = req.body;

      if (
        !minerAddress ||
        typeof minerAddress !==
          "string"
      ) {
        return res
          .status(400)
          .json({
            success: false,

            error:
              "Adresse du mineur obligatoire."
          });
      }

      const previousPending =
        [
          ...koala
            .pendingTransactions
        ];

      const previousTotal =
        koala.totalMined;

      const result =
        koala
          .minePendingTransactions(
            minerAddress
          );

      try {
        await saveBlock(
          result.block
        );

      } catch (
        databaseError
      ) {
        /*
          PostgreSQL a refusé le bloc.

          On restaure donc l'état mémoire
          précédent.
        */

        koala.chain.pop();

        koala.pendingTransactions =
          previousPending;

        koala.totalMined =
          previousTotal;

        throw databaseError;
      }

      res.json({
        success: true,

        message:
          "Nouveau bloc KOA créé et sauvegardé.",

        reward:
          result.reward,

        minerAddress,

        balance:
          koala
            .getBalanceOfAddress(
              minerAddress
            ),

        block:
          result.block
      });

    } catch (error) {
      console.error(
        "Erreur minage :",
        error
      );

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

// ============================================================
// VALIDATION BLOCKCHAIN
// ============================================================

app.get(
  "/api/validate",
  (req, res) => {
    res.json({
      valid:
        koala.isChainValid()
    });
  }
);

// ============================================================
// START
// ============================================================

async function start() {
  try {
    console.log(
      "Connexion PostgreSQL..."
    );

    await pool.query(
      "SELECT 1"
    );

    console.log(
      "PostgreSQL connecté."
    );

    await createTables();

    await restoreBlockchain();

    // --------------------------------------------------------
    // VÉRIFICATION DE LA BLOCKCHAIN RESTAURÉE
    // --------------------------------------------------------

    if (
      !koala.isChainValid()
    ) {
      throw new Error(
        "Blockchain PostgreSQL invalide."
      );
    }

    databaseReady =
      true;

    app.listen(
      PORT,
      "0.0.0.0",
      () => {
        console.log(
          "======================================"
        );

        console.log(
          "KOALA BLOCKCHAIN"
        );

        console.log(
          "Monnaie native : KOA"
        );

        console.log(
          "Wallet cryptographique : OK"
        );

        console.log(
          "Signatures secp256k1 : OK"
        );

        console.log(
          "Bibliothèque navigateur secp256k1 : OK"
        );

        console.log(
          "Transactions signées côté client : API prête"
        );

        console.log(
          "Clé privée dans /api/transactions : NON"
        );

        console.log(
          "PostgreSQL : OK"
        );

        console.log(
          `Port : ${PORT}`
        );

        console.log(
          "======================================"
        );
      }
    );

  } catch (error) {
    console.error(
      "Impossible de démarrer Koala Blockchain :",
      error
    );

    process.exit(1);
  }
}

start();