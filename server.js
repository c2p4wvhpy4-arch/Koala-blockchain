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

const PORT = Number(
  process.env.PORT || 3000
);

const DATABASE_URL =
  process.env.DATABASE_URL;

const NODE_URL = String(
  process.env.NODE_URL || ""
)
  .trim()
  .replace(/\/+$/, "");

const HASH_FORMAT_VERSION = 2;

if (!DATABASE_URL) {
  console.error(
    "DATABASE_URL non configurée."
  );
  process.exit(1);
}

app.use(
  express.json({
    limit: "2mb"
  })
);

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
// SECP256K1 NAVIGATEUR
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

let databaseReady = false;

// ============================================================
// OUTILS RÉSEAU
// ============================================================

function normalizeNodeUrl(
  value
) {
  if (
    typeof value !== "string"
  ) {
    return null;
  }

  const cleaned =
    value
      .trim()
      .replace(/\/+$/, "");

  if (!cleaned) {
    return null;
  }

  let parsed;

  try {
    parsed =
      new URL(cleaned);
  } catch {
    return null;
  }

  if (
    parsed.protocol !==
      "http:" &&
    parsed.protocol !==
      "https:"
  ) {
    return null;
  }

  return (
    parsed.origin +
    parsed.pathname.replace(
      /\/+$/,
      ""
    )
  );
}

function sameNode(
  first,
  second
) {
  const a =
    normalizeNodeUrl(first);

  const b =
    normalizeNodeUrl(second);

  return (
    a &&
    b &&
    a === b
  );
}

async function fetchJson(
  url,
  options = {},
  timeout = 8000
) {
  const controller =
    new AbortController();

  const timer =
    setTimeout(
      () =>
        controller.abort(),
      timeout
    );

  try {
    const response =
      await fetch(
        url,
        {
          ...options,

          signal:
            controller.signal,

          headers: {
            "Content-Type":
              "application/json",

            ...(options.headers ||
              {})
          }
        }
      );

    let data = null;

    try {
      data =
        await response.json();
    } catch {
      data = null;
    }

    if (!response.ok) {
      throw new Error(
        data?.error ||
          `HTTP ${response.status}`
      );
    }

    return data;

  } finally {
    clearTimeout(
      timer
    );
  }
}

// ============================================================
// CRÉATION TABLES
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

  // ----------------------------------------------------------
  // NŒUDS DU RÉSEAU
  // ----------------------------------------------------------

  await pool.query(`
    CREATE TABLE IF NOT EXISTS koa_nodes (
      id BIGSERIAL PRIMARY KEY,
      url TEXT UNIQUE NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_seen_at TIMESTAMPTZ
    );
  `);

  console.log(
    "Tables PostgreSQL KOA : OK"
  );

  console.log(
    "Table réseau KOA : OK"
  );
}

// ============================================================
// ÉTAT
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

async function saveState(
  client = pool
) {
  const state = {
    hashFormat:
      HASH_FORMAT_VERSION,

    totalMined:
      koala.totalMined,

    pendingTransactions:
      canonicalTransactions(
        koala.pendingTransactions
      )
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
// NŒUDS POSTGRESQL
// ============================================================

async function getNodes() {
  const result =
    await pool.query(`
      SELECT
        url,
        created_at,
        last_seen_at
      FROM koa_nodes
      ORDER BY id ASC
    `);

  return result.rows;
}

async function getNodeUrls() {
  const nodes =
    await getNodes();

  return nodes
    .map(
      node =>
        normalizeNodeUrl(
          node.url
        )
    )
    .filter(Boolean);
}

async function registerNode(
  nodeUrl
) {
  const normalized =
    normalizeNodeUrl(
      nodeUrl
    );

  if (!normalized) {
    throw new Error(
      "URL du nœud invalide."
    );
  }

  if (
    NODE_URL &&
    sameNode(
      normalized,
      NODE_URL
    )
  ) {
    return {
      added: false,
      url: normalized,
      self: true
    };
  }

  const result =
    await pool.query(
      `
      INSERT INTO koa_nodes (
        url,
        last_seen_at
      )
      VALUES (
        $1,
        NOW()
      )
      ON CONFLICT (url)
      DO UPDATE SET
        last_seen_at = NOW()
      RETURNING url
      `,
      [
        normalized
      ]
    );

  return {
    added: true,
    url:
      result.rows[0].url,
    self: false
  };
}

// ============================================================
// CONSTRUCTION BLOC
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

  block.hash =
    row.hash;

  return block;
}

function blockFromNetwork(
  raw
) {
  if (
    !raw ||
    typeof raw !== "object"
  ) {
    throw new Error(
      "Bloc réseau invalide."
    );
  }

  const block =
    new Block(
      Number(
        raw.index
      ),

      Number(
        raw.timestamp
      ),

      canonicalTransactions(
        raw.transactions
      ),

      String(
        raw.previousHash
      )
    );

  block.nonce =
    Number(
      raw.nonce
    );

  block.hash =
    String(
      raw.hash
    );

  return block;
}

// ============================================================
// CONSTRUCTION CHAÎNE RÉSEAU
// ============================================================

function buildNetworkChain(
  rawChain
) {
  if (
    !Array.isArray(
      rawChain
    ) ||
    rawChain.length === 0
  ) {
    throw new Error(
      "Chaîne réseau invalide."
    );
  }

  return rawChain.map(
    raw =>
      blockFromNetwork(
        raw
      )
  );
}

// ============================================================
// VALIDATION CHAÎNE EXTERNE
// ============================================================

function validateExternalChain(
  rawChain
) {
  try {
    const chain =
      buildNetworkChain(
        rawChain
      );

    const candidate =
      new KoalaBlockchain();

    candidate.chain =
      chain;

    candidate.totalMined =
      calculateTotalMinedForChain(
        chain
      );

    const valid =
      candidate.isChainValid();

    return {
      valid,
      chain,
      totalMined:
        candidate.totalMined
    };

  } catch (error) {
    console.error(
      "Chaîne externe invalide :",
      error.message
    );

    return {
      valid: false,
      chain: null,
      totalMined: 0
    };
  }
}

// ============================================================
// TOTAL MINÉ
// ============================================================

function calculateTotalMinedForChain(
  chain
) {
  let total = 0;

  for (
    const block
    of chain
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

function calculateTotalMined() {
  return calculateTotalMinedForChain(
    koala.chain
  );
}

// ============================================================
// SAUVEGARDE BLOC
// ============================================================

async function insertBlockWithClient(
  client,
  block
) {
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

async function saveBlock(
  block
) {
  const client =
    await pool.connect();

  try {
    await client.query(
      "BEGIN"
    );

    const exists =
      await client.query(
        `
        SELECT
          block_index,
          hash
        FROM koa_blocks
        WHERE block_index = $1
        LIMIT 1
        `,
        [
          block.index
        ]
      );

    if (
      exists.rows.length >
      0
    ) {
      if (
        exists.rows[0].hash ===
        block.hash
      ) {
        await client.query(
          "COMMIT"
        );

        return false;
      }

      throw new Error(
        `Conflit au bloc #${block.index}.`
      );
    }

    await insertBlockWithClient(
      client,
      block
    );

    await saveState(
      client
    );

    await client.query(
      "COMMIT"
    );

    return true;

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
// REMPLACEMENT COMPLET DE LA CHAÎNE
// ============================================================

async function replaceChain(
  newChain
) {
  const validation =
    validateExternalChain(
      newChain
    );

  if (!validation.valid) {
    throw new Error(
      "La nouvelle blockchain est invalide."
    );
  }

  const chain =
    validation.chain;

  const client =
    await pool.connect();

  try {
    await client.query(
      "BEGIN"
    );

    await client.query(
      "DELETE FROM koa_transactions"
    );

    await client.query(
      "DELETE FROM koa_blocks"
    );

    for (
      const block
      of chain
    ) {
      await insertBlockWithClient(
        client,
        block
      );
    }

    koala.chain =
      chain;

    koala.totalMined =
      validation.totalMined;

    /*
      Après un remplacement de chaîne,
      on vide les transactions en attente.

      Pour ce premier réseau multi-nœuds,
      cela évite de réinjecter une transaction
      déjà confirmée dans la chaîne reçue.
    */

    koala.pendingTransactions =
      [];

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
// MIGRATION HASH FORMAT 2
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

      const previousHash =
        i === 0
          ? row.previous_hash
          : migratedChain[
              i - 1
            ].hash;

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

    const totalMined =
      calculateTotalMinedForChain(
        migratedChain
      );

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

    throw error;

  } finally {
    client.release();
  }
}

// ============================================================
// FORMAT HASH
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
// RESTAURATION
// ============================================================

async function restoreBlockchain() {
  const result =
    await pool.query(`
      SELECT *
      FROM koa_blocks
      ORDER BY block_index ASC
    `);

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

  koala.chain =
    result.rows.map(
      row =>
        blockFromRow(
          row
        )
    );

  const state =
    await getStoredState();

  koala.totalMined =
    calculateTotalMined();

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
// IDENTIFIANT TRANSACTION
// ============================================================

function transactionId(
  transaction
) {
  return [
    transaction.fromAddress,
    transaction.toAddress,
    Number(
      transaction.amount
    ),
    Number(
      transaction.timestamp
    ),
    transaction.signature ||
      ""
  ].join("|");
}

function pendingContains(
  transaction
) {
  const id =
    transactionId(
      transaction
    );

  return koala
    .pendingTransactions
    .some(
      tx =>
        transactionId(tx) ===
        id
    );
}

// ============================================================
// DIFFUSION TRANSACTION
// ============================================================

async function broadcastTransaction(
  transaction
) {
  const nodes =
    await getNodeUrls();

  const results =
    await Promise.allSettled(
      nodes.map(
        node =>
          fetchJson(
            `${node}/api/network/transaction`,
            {
              method:
                "POST",

              body:
                JSON.stringify({
                  transaction
                })
            }
          )
      )
    );

  return results.map(
    (
      result,
      index
    ) => ({
      node:
        nodes[index],

      success:
        result.status ===
        "fulfilled",

      error:
        result.status ===
        "rejected"
          ? result.reason
              ?.message
          : null
    })
  );
}

// ============================================================
// DIFFUSION BLOC
// ============================================================

async function broadcastBlock(
  block
) {
  const nodes =
    await getNodeUrls();

  const results =
    await Promise.allSettled(
      nodes.map(
        node =>
          fetchJson(
            `${node}/api/network/block`,
            {
              method:
                "POST",

              body:
                JSON.stringify({
                  block
                })
            }
          )
      )
    );

  return results.map(
    (
      result,
      index
    ) => ({
      node:
        nodes[index],

      success:
        result.status ===
        "fulfilled",

      error:
        result.status ===
        "rejected"
          ? result.reason
              ?.message
          : null
    })
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
        koala.symbol,

      node:
        NODE_URL ||
        null,

      network:
        true
    });
  }
);

// ============================================================
// INFO
// ============================================================

app.get(
  "/api/info",
  async (req, res) => {
    try {
      const nodes =
        await getNodeUrls();

      res.json({
        name:
          koala.name,

        symbol:
          koala.symbol,

        database:
          databaseReady,

        node:
          NODE_URL ||
          null,

        nodes:
          nodes.length,

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

    } catch (error) {
      res
        .status(500)
        .json({
          error:
            error.message
        });
    }
  }
);

// ============================================================
// CHAÎNE COMPLÈTE POUR LES AUTRES NŒUDS
// ============================================================

app.get(
  "/api/chain",
  (req, res) => {
    res.json({
      name:
        koala.name,

      symbol:
        koala.symbol,

      node:
        NODE_URL ||
        null,

      length:
        koala.chain.length,

      totalMined:
        koala.totalMined,

      difficulty:
        koala.difficulty,

      hashFormat:
        HASH_FORMAT_VERSION,

      chain:
        koala.chain
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
// WALLET
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
          "Conserve la clé privée uniquement sur ton appareil."
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
// TRANSACTIONS ADRESSE
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
// CRÉATION TRANSACTION DEPUIS CLIENT
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
        Number(amount);

      const numericTimestamp =
        Number(timestamp);

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

      const network =
        await broadcastTransaction(
          transaction
        );

      res
        .status(201)
        .json({
          success: true,

          message:
            "Transaction KOA signée, vérifiée et diffusée au réseau.",

          transaction,

          network
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
// TRANSACTION REÇUE D'UN AUTRE NŒUD
// ============================================================

app.post(
  "/api/network/transaction",
  async (req, res) => {
    try {
      const raw =
        req.body
          ?.transaction;

      if (!raw) {
        return res
          .status(400)
          .json({
            success: false,
            error:
              "Transaction manquante."
          });
      }

      const transaction =
        Object.assign(
          new Transaction(),
          raw
        );

      if (
        !transaction.isValid()
      ) {
        return res
          .status(400)
          .json({
            success: false,
            error:
              "Transaction réseau invalide."
          });
      }

      if (
        pendingContains(
          transaction
        )
      ) {
        return res.json({
          success: true,
          duplicate: true
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
            "Transaction réseau acceptée."
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

      const network =
        await broadcastBlock(
          result.block
        );

      res.json({
        success: true,

        message:
          "Nouveau bloc KOA créé, sauvegardé et diffusé au réseau.",

        reward:
          result.reward,

        minerAddress,

        balance:
          koala
            .getBalanceOfAddress(
              minerAddress
            ),

        block:
          result.block,

        network
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
// BLOC REÇU D'UN AUTRE NŒUD
// ============================================================

app.post(
  "/api/network/block",
  async (req, res) => {
    try {
      const rawBlock =
        req.body?.block;

      if (!rawBlock) {
        return res
          .status(400)
          .json({
            success: false,
            error:
              "Bloc manquant."
          });
      }

      const incomingBlock =
        blockFromNetwork(
          rawBlock
        );

      const existing =
        koala.chain.find(
          block =>
            block.index ===
            incomingBlock.index
        );

      if (
        existing &&
        existing.hash ===
          incomingBlock.hash
      ) {
        return res.json({
          success: true,
          duplicate: true
        });
      }

      const latest =
        koala.getLatestBlock();

      /*
        Le bloc doit être exactement
        le suivant de notre chaîne.
      */

      if (
        incomingBlock.index !==
        latest.index + 1 ||
        incomingBlock.previousHash !==
        latest.hash
      ) {
        return res
          .status(409)
          .json({
            success: false,

            syncRequired: true,

            error:
              "Chaîne locale différente. Consensus nécessaire."
          });
      }

      const candidateChain = [
        ...koala.chain,
        incomingBlock
      ];

      const validation =
        validateExternalChain(
          candidateChain
        );

      if (
        !validation.valid
      ) {
        return res
          .status(400)
          .json({
            success: false,

            error:
              "Bloc réseau invalide."
          });
      }

      const previousChain =
        koala.chain;

      const previousPending =
        koala.pendingTransactions;

      const previousTotal =
        koala.totalMined;

      koala.chain =
        validation.chain;

      koala.totalMined =
        validation.totalMined;

      /*
        On retire des pending les transactions
        désormais présentes dans le bloc reçu.
      */

      const confirmedIds =
        new Set(
          incomingBlock
            .transactions
            .filter(
              tx =>
                tx.fromAddress !==
                null
            )
            .map(
              tx =>
                transactionId(
                  tx
                )
            )
        );

      koala.pendingTransactions =
        previousPending.filter(
          tx =>
            !confirmedIds.has(
              transactionId(
                tx
              )
            )
        );

      try {
        await saveBlock(
          incomingBlock
        );

        await saveState();

      } catch (error) {
        koala.chain =
          previousChain;

        koala.pendingTransactions =
          previousPending;

        koala.totalMined =
          previousTotal;

        throw error;
      }

      res
        .status(201)
        .json({
          success: true,

          message:
            `Bloc #${incomingBlock.index} accepté.`,

          blocks:
            koala.chain.length,

          totalMined:
            koala.totalMined
        });

    } catch (error) {
      console.error(
        "Erreur bloc réseau :",
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
// LISTE DES NŒUDS
// ============================================================

app.get(
  "/api/nodes",
  async (req, res) => {
    try {
      const nodes =
        await getNodes();

      res.json({
        success: true,

        currentNode:
          NODE_URL ||
          null,

        count:
          nodes.length,

        nodes
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
// ENREGISTRER UN NŒUD
// ============================================================

app.post(
  "/api/nodes/register",
  async (req, res) => {
    try {
      const nodeUrl =
        req.body?.nodeUrl;

      const result =
        await registerNode(
          nodeUrl
        );

      res
        .status(201)
        .json({
          success: true,
          node:
            result.url,
          self:
            result.self
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

// ============================================================
// ENREGISTREMENT + DIFFUSION DU NŒUD
// ============================================================

app.post(
  "/api/nodes/broadcast",
  async (req, res) => {
    try {
      const newNode =
        normalizeNodeUrl(
          req.body?.nodeUrl
        );

      if (!newNode) {
        return res
          .status(400)
          .json({
            success: false,
            error:
              "URL du nœud invalide."
          });
      }

      await registerNode(
        newNode
      );

      const currentNodes =
        await getNodeUrls();

      /*
        On annonce le nouveau nœud
        aux nœuds déjà connus.
      */

      const targets =
        currentNodes.filter(
          node =>
            !sameNode(
              node,
              newNode
            )
        );

      await Promise.allSettled(
        targets.map(
          node =>
            fetchJson(
              `${node}/api/nodes/register`,
              {
                method:
                  "POST",

                body:
                  JSON.stringify({
                    nodeUrl:
                      newNode
                  })
              }
            )
        )
      );

      /*
        On donne au nouveau nœud
        la liste des autres nœuds.
      */

      const nodesForNewNode =
        new Set(
          currentNodes
        );

      if (NODE_URL) {
        nodesForNewNode.add(
          NODE_URL
        );
      }

      nodesForNewNode.delete(
        newNode
      );

      for (
        const node
        of nodesForNewNode
      ) {
        try {
          await fetchJson(
            `${newNode}/api/nodes/register`,
            {
              method:
                "POST",

              body:
                JSON.stringify({
                  nodeUrl:
                    node
                })
            }
          );
        } catch (
          error
        ) {
          console.error(
            `Impossible d'enregistrer ${node} sur ${newNode} :`,
            error.message
          );
        }
      }

      res.json({
        success: true,

        message:
          "Nœud enregistré et diffusé.",

        node:
          newNode,

        nodes:
          await getNodeUrls()
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

// ============================================================
// CONSENSUS
// ============================================================

app.post(
  "/api/consensus",
  async (req, res) => {
    try {
      const nodes =
        await getNodeUrls();

      let bestChain =
        koala.chain;

      let bestLength =
        koala.chain.length;

      let source =
        NODE_URL ||
        "local";

      const checked =
        [];

      for (
        const node
        of nodes
      ) {
        try {
          const data =
            await fetchJson(
              `${node}/api/chain`
            );

          if (
            !data ||
            !Array.isArray(
              data.chain
            )
          ) {
            throw new Error(
              "Réponse blockchain invalide."
            );
          }

          const validation =
            validateExternalChain(
              data.chain
            );

          checked.push({
            node,

            length:
              data.chain.length,

            valid:
              validation.valid
          });

          /*
            Pour cette première version :
            chaîne valide la plus longue.
          */

          if (
            validation.valid &&
            data.chain.length >
              bestLength
          ) {
            bestChain =
              data.chain;

            bestLength =
              data.chain.length;

            source =
              node;
          }

        } catch (error) {
          checked.push({
            node,
            valid: false,
            error:
              error.message
          });
        }
      }

      if (
        bestLength >
        koala.chain.length
      ) {
        await replaceChain(
          bestChain
        );

        return res.json({
          success: true,

          replaced: true,

          message:
            "Blockchain locale synchronisée.",

          source,

          blocks:
            koala.chain.length,

          totalMined:
            koala.totalMined,

          checked
        });
      }

      res.json({
        success: true,

        replaced: false,

        message:
          "Blockchain locale déjà à jour.",

        blocks:
          koala.chain.length,

        totalMined:
          koala.totalMined,

        checked
      });

    } catch (error) {
      console.error(
        "Erreur consensus :",
        error
      );

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
// VALIDATION
// ============================================================

app.get(
  "/api/validate",
  (req, res) => {
    res.json({
      valid:
        koala.isChainValid(),

      hashFormat:
        HASH_FORMAT_VERSION,

      blocks:
        koala.chain.length,

      totalMined:
        koala.totalMined
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
    // HASH FORMAT
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
          "Validation renforcée : OK"
        );

        console.log(
          "Réseau multi-nœuds : OK"
        );

        console.log(
          `NODE_URL : ${NODE_URL || "NON CONFIGURÉ"}`
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