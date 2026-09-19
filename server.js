const express = require("express");
const path = require("path");
const { Pool } = require("pg");

const {
  KoalaBlockchain,
  Transaction,
  Block,
  createWallet,
  canonicalTransactions
} = require("./blockchain");

const app = express();

const PORT =
  Number(process.env.PORT || 3000);

const DATABASE_URL =
  process.env.DATABASE_URL;

const HASH_FORMAT_VERSION = 2;

if (!DATABASE_URL) {
  console.error(
    "DATABASE_URL non configurée."
  );

  process.exit(1);
}

app.use(express.json());

// ============================================================
// FICHIERS PUBLICS
// ============================================================

app.use(
  express.static(
    path.join(
      __dirname,
      "public"
    )
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

const pool =
  new Pool({
    connectionString:
      DATABASE_URL,

    ssl:
      process.env.NODE_ENV ===
      "production"
        ? {
            rejectUnauthorized:
              false
          }
        : false
  });

const koala =
  new KoalaBlockchain();

let databaseReady =
  false;

// ============================================================
// CRÉATION DES TABLES
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
// LECTURE ÉTAT
// ============================================================

async function getStoredState(
  client = pool
) {
  const result =
    await client.query(`
      SELECT value
      FROM koa_state
      WHERE key = 'blockchain'
      LIMIT 1
    `);

  if (
    result.rows.length === 0
  ) {
    return {};
  }

  return (
    result.rows[0].value ||
    {}
  );
}

// ============================================================
// SAUVEGARDE ÉTAT
// ============================================================

async function saveState(
  client = pool
) {
  const state = {
    hashFormat:
      HASH_FORMAT_VERSION,

    totalMined:
      koala.totalMined,

    pendingTransactions:
      koala.pendingTransactions
  };

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
      JSON.stringify(
        state
      )
    ]
  );
}

// ============================================================
// CONSTRUCTION D'UN BLOC DEPUIS POSTGRESQL
// ============================================================

function blockFromRow(row) {
  const transactions =
    canonicalTransactions(
      Array.isArray(
        row.transactions
      )
        ? row.transactions
        : []
    );

  const block =
    new Block(
      Number(
        row.block_index
      ),

      Number(
        row.timestamp
      ),

      transactions,

      row.previous_hash
    );

  block.nonce =
    Number(
      row.nonce
    );

  /*
    IMPORTANT :

    Le constructeur calcule automatiquement
    un nouveau hash.

    Lors de la restauration normale,
    on remet ensuite le hash enregistré
    dans PostgreSQL.

    Cela permet à isChainValid()
    de le comparer au hash recalculé.
  */

  block.hash =
    row.hash;

  return block;
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
            canonicalTransactions(
              block.transactions
            )
          )
        ]
      );

    if (
      insertedBlock.rowCount >
      0
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

            Number(
              tx.amount
            ),

            tx.publicKey ||
              null,

            tx.signature ||
              null,

            Number(
              tx.timestamp
            )
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
// CALCUL DU TOTAL DE KOA DEPUIS LA BLOCKCHAIN
// ============================================================

function calculateTotalMined() {
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
        tx.fromAddress ===
        null
      ) {
        total +=
          Number(
            tx.amount
          );
      }
    }
  }

  return total;
}

// ============================================================
// MIGRATION ANCIEN HASH -> HASH FORMAT 2
//
// Cette fonction ne modifie PAS :
//
// - les transactions
// - les montants
// - les adresses
// - les timestamps des transactions
// - les soldes
//
// Elle recalcule uniquement :
//
// - previousHash
// - hash
//
// pour rendre les blocs compatibles avec la sérialisation
// déterministe.
// ============================================================

async function migrateHashFormat() {
  console.log(
    "Migration blockchain vers hash format 2..."
  );

  const client =
    await pool.connect();

  try {
    await client.query(
      "BEGIN"
    );

    const result =
      await client.query(`
        SELECT *
        FROM koa_blocks
        ORDER BY block_index ASC
        FOR UPDATE
      `);

    if (
      result.rows.length ===
      0
    ) {
      await client.query(
        "COMMIT"
      );

      return;
    }

    const migratedChain =
      [];

    for (
      let i = 0;
      i <
      result.rows.length;
      i++
    ) {
      const row =
        result.rows[i];

      const transactions =
        canonicalTransactions(
          Array.isArray(
            row.transactions
          )
            ? row.transactions
            : []
        );

      let previousHash;

      if (i === 0) {
        /*
          Genesis conserve son previousHash.
        */

        previousHash =
          row.previous_hash;
      } else {
        previousHash =
          migratedChain[
            i - 1
          ].hash;
      }

      const block =
        new Block(
          Number(
            row.block_index
          ),

          Number(
            row.timestamp
          ),

          transactions,

          previousHash
        );

      /*
        On conserve le nonce historique.

        Le hash est ensuite recalculé avec
        la nouvelle sérialisation déterministe.
      */

      block.nonce =
        Number(
          row.nonce
        );

      block.hash =
        block.calculateHash();

      migratedChain.push(
        block
      );
    }

    /*
      On met d'abord des hash temporaires.

      Cela évite un conflit avec la contrainte
      UNIQUE de la colonne hash pendant la
      migration.
    */

    for (
      const block
      of migratedChain
    ) {
      await client.query(
        `
        UPDATE koa_blocks
        SET hash = $1
        WHERE block_index = $2
        `,
        [
          `migration-temp-${block.index}-${Date.now()}`,

          block.index
        ]
      );
    }

    /*
      Puis on écrit les nouveaux blocs.
    */

    for (
      const block
      of migratedChain
    ) {
      await client.query(
        `
        UPDATE koa_blocks
        SET
          previous_hash = $1,
          hash = $2,
          nonce = $3,
          transactions = $4::jsonb
        WHERE block_index = $5
        `,
        [
          block.previousHash,

          block.hash,

          block.nonce,

          JSON.stringify(
            canonicalTransactions(
              block.transactions
            )
          ),

          block.index
        ]
      );
    }

    /*
      On calcule le total directement
      depuis les récompenses existantes.

      Les 50 KOA du bloc #1 restent donc
      exactement les mêmes.
    */

    let totalMined = 0;

    for (
      const block
      of migratedChain
    ) {
      for (
        const tx
        of block.transactions
      ) {
        if (
          tx.fromAddress ===
          null
        ) {
          totalMined +=
            Number(
              tx.amount
            );
        }
      }
    }

    const oldState =
      await getStoredState(
        client
      );

    const pendingTransactions =
      Array.isArray(
        oldState
          .pendingTransactions
      )
        ? oldState
            .pendingTransactions
        : [];

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
          hashFormat:
            HASH_FORMAT_VERSION,

          totalMined,

          pendingTransactions
        })
      ]
    );

    await client.query(
      "COMMIT"
    );

    console.log(
      "Migration blockchain : OK"
    );

    console.log(
      `Blocs migrés : ${migratedChain.length}`
    );

    console.log(
      `KOA conservés : ${totalMined}`
    );

  } catch (error) {
    await client.query(
      "ROLLBACK"
    );

    console.error(
      "Erreur migration blockchain :",
      error
    );

    throw error;

  } finally {
    client.release();
  }
}

// ============================================================
// VÉRIFICATION DU FORMAT DE HASH
// ============================================================

async function ensureHashFormat() {
  const blocks =
    await pool.query(`
      SELECT COUNT(*)::integer AS count
      FROM koa_blocks
    `);

  const blockCount =
    Number(
      blocks.rows[0].count
    );

  /*
    Nouvelle blockchain vide :
    aucune migration nécessaire.
  */

  if (
    blockCount === 0
  ) {
    return;
  }

  const state =
    await getStoredState();

  const hashFormat =
    Number(
      state.hashFormat || 1
    );

  console.log(
    `Format hash PostgreSQL : ${hashFormat}`
  );

  if (
    hashFormat <
    HASH_FORMAT_VERSION
  ) {
    await migrateHashFormat();
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
  // PREMIÈRE INSTALLATION
  // ----------------------------------------------------------

  if (
    result.rows.length ===
    0
  ) {
    console.log(
      "Première installation KOA."
    );

    await saveBlock(
      koala.chain[0]
    );

    console.log(
      "Bloc Genesis sauvegardé dans PostgreSQL."
    );

    return;
  }

  // ----------------------------------------------------------
  // RECONSTRUCTION
  // ----------------------------------------------------------

  koala.chain =
    result.rows.map(
      row =>
        blockFromRow(
          row
        )
    );

  // ----------------------------------------------------------
  // ÉTAT
  // ----------------------------------------------------------

  const state =
    await getStoredState();

  const totalFromChain =
    calculateTotalMined();

  /*
    La blockchain confirmée est la source
    de vérité pour le nombre de KOA créés.
  */

  koala.totalMined =
    totalFromChain;

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

      hashFormat:
        HASH_FORMAT_VERSION,

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
      koala.chain.find(
        item =>
          item.index ===
          index
      );

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

      const transaction =
        new Transaction(
          fromAddress,
          toAddress,
          numericAmount,
          publicKey
        );

      transaction.timestamp =
        numericTimestamp;

      transaction.signature =
        signature;

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

      koala.createTransaction(
        transaction
      );

      await saveState();

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
// VALIDATION
// ============================================================

app.get(
  "/api/validate",
  (req, res) => {
    res.json({
      valid:
        koala.isChainValid(),

      hashFormat:
        HASH_FORMAT_VERSION
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

    // --------------------------------------------------------
    // MIGRATION UNE SEULE FOIS
    // --------------------------------------------------------

    await ensureHashFormat();

    // --------------------------------------------------------
    // RESTAURATION
    // --------------------------------------------------------

    await restoreBlockchain();

    // --------------------------------------------------------
    // VALIDATION
    // --------------------------------------------------------

    if (
      !koala.isChainValid()
    ) {
      throw new Error(
        "Blockchain PostgreSQL invalide après restauration."
      );
    }

    /*
      Réécrit l'état afin de garantir que
      hashFormat et totalMined correspondent
      à la blockchain restaurée.
    */

    await saveState();

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
          `Format hash : ${HASH_FORMAT_VERSION}`
        );

        console.log(
          `Blocs : ${koala.chain.length}`
        );

        console.log(
          `KOA créés : ${koala.totalMined}`
        );

        console.log(
          "Wallet cryptographique : OK"
        );

        console.log(
          "Signatures secp256k1 : OK"
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