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

const PORT = Number(process.env.PORT || 3000);
const DATABASE_URL = process.env.DATABASE_URL || "";

const NODE_URL = String(process.env.NODE_URL || "")
  .trim()
  .replace(/\/+$/, "");

const BOOTSTRAP_NODE = String(process.env.BOOTSTRAP_NODE || "")
  .trim()
  .replace(/\/+$/, "");

const HASH_FORMAT_VERSION = 2;
const USE_DATABASE = Boolean(DATABASE_URL);

app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "public")));

app.get("/vendor/secp256k1.js", (req, res) => {
  res.sendFile(
    path.join(
      __dirname,
      "node_modules",
      "@noble",
      "secp256k1",
      "index.js"
    ),
    error => {
      if (error && !res.headersSent) {
        console.error(
          "Erreur chargement secp256k1 :",
          error.message
        );

        res
          .status(404)
          .send("Bibliothèque secp256k1 introuvable.");
      }
    }
  );
});

// ============================================================
// STOCKAGE
// ============================================================

const pool = USE_DATABASE
  ? new Pool({
      connectionString: DATABASE_URL,
      ssl:
        process.env.NODE_ENV === "production"
          ? { rejectUnauthorized: false }
          : false
    })
  : null;

const koala = new KoalaBlockchain();

let databaseReady = false;
let synchronized = USE_DATABASE;

// Liste des pairs en mémoire.
// Sur le nœud PostgreSQL, elle est également persistée en base.

const memoryNodes = new Map();

// ============================================================
// OUTILS RÉSEAU
// ============================================================

function normalizeNodeUrl(value) {
  if (typeof value !== "string") {
    return null;
  }

  const cleaned = value
    .trim()
    .replace(/\/+$/, "");

  if (!cleaned) {
    return null;
  }

  try {
    const parsed = new URL(cleaned);

    if (
      parsed.protocol !== "http:" &&
      parsed.protocol !== "https:"
    ) {
      return null;
    }

    return (
      parsed.origin +
      parsed.pathname.replace(/\/+$/, "")
    );
  } catch {
    return null;
  }
}

function sameNode(first, second) {
  const a = normalizeNodeUrl(first);
  const b = normalizeNodeUrl(second);

  return Boolean(
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
  const controller = new AbortController();

  const timer = setTimeout(
    () => controller.abort(),
    timeout
  );

  try {
    const response = await fetch(url, {
      ...options,

      signal: controller.signal,

      headers: {
        "Content-Type": "application/json",
        ...(options.headers || {})
      }
    });

    let data = null;

    try {
      data = await response.json();
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
    clearTimeout(timer);
  }
}

// ============================================================
// POSTGRESQL
// ============================================================

async function createTables() {
  if (!USE_DATABASE) {
    return;
  }

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

async function getStoredState(
  client = pool
) {
  if (!USE_DATABASE) {
    return {};
  }

  const result = await client.query(`
    SELECT value
    FROM koa_state
    WHERE key = 'blockchain'
    LIMIT 1
  `);

  return result.rows.length
    ? result.rows[0].value || {}
    : {};
}

async function saveState(
  client = pool
) {
  if (!USE_DATABASE) {
    return;
  }

  const state = {
    hashFormat: HASH_FORMAT_VERSION,

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
      JSON.stringify(state)
    ]
  );
}

// ============================================================
// NŒUDS
// ============================================================

async function getNodes() {
  if (!USE_DATABASE) {
    return Array
      .from(memoryNodes.values())
      .map(item => ({
        ...item
      }));
  }

  const result =
    await pool.query(`
      SELECT
        url,
        created_at,
        last_seen_at
      FROM koa_nodes
      ORDER BY id ASC
    `);

  const merged =
    new Map();

  for (const row of result.rows) {
    merged.set(
      row.url,
      row
    );
  }

  for (
    const [url, row]
    of memoryNodes.entries()
  ) {
    if (!merged.has(url)) {
      merged.set(
        url,
        row
      );
    }
  }

  return Array.from(
    merged.values()
  );
}

async function getNodeUrls() {
  const nodes =
    await getNodes();

  return nodes
    .map(node =>
      normalizeNodeUrl(
        node.url
      )
    )
    .filter(Boolean)
    .filter(
      node =>
        !(
          NODE_URL &&
          sameNode(
            node,
            NODE_URL
          )
        )
    );
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

  const now =
    new Date().toISOString();

  memoryNodes.set(
    normalized,
    {
      url: normalized,

      created_at:
        memoryNodes
          .get(normalized)
          ?.created_at ||
        now,

      last_seen_at: now
    }
  );

  if (USE_DATABASE) {
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

  return {
    added: true,
    url: normalized,
    self: false
  };
}

// ============================================================
// BLOCS / CHAÎNES
// ============================================================

function blockFromRow(row) {
  const block =
    new Block(
      Number(
        row.block_index
      ),

      Number(
        row.timestamp
      ),

      canonicalTransactions(
        Array.isArray(
          row.transactions
        )
          ? row.transactions
          : []
      ),

      row.previous_hash
    );

  block.nonce =
    Number(row.nonce);

  block.hash =
    row.hash;

  return block;
}

function blockFromNetwork(raw) {
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
      Number(raw.index),

      Number(raw.timestamp),

      canonicalTransactions(
        Array.isArray(
          raw.transactions
        )
          ? raw.transactions
          : []
      ),

      String(
        raw.previousHash
      )
    );

  block.nonce =
    Number(raw.nonce);

  block.hash =
    String(raw.hash);

  return block;
}

function buildNetworkChain(
  rawChain
) {
  if (
    !Array.isArray(rawChain) ||
    rawChain.length === 0
  ) {
    throw new Error(
      "Chaîne réseau invalide."
    );
  }

  return rawChain.map(
    blockFromNetwork
  );
}

function calculateTotalMinedForChain(
  chain
) {
  let total = 0;

  for (const block of chain) {
    for (
      const tx
      of block.transactions
    ) {
      if (
        tx.fromAddress === null
      ) {
        total +=
          Number(tx.amount);
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
// PERSISTANCE DES BLOCS
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
        Number(tx.amount),
        tx.publicKey || null,
        tx.signature || null,
        Number(tx.timestamp)
      ]
    );
  }
}

async function saveBlock(
  block
) {
  if (!USE_DATABASE) {
    return true;
  }

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
      exists.rows.length > 0
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

  if (!USE_DATABASE) {
    koala.chain =
      validation.chain;

    koala.totalMined =
      validation.totalMined;

    koala.pendingTransactions =
      [];

    synchronized = true;

    return;
  }

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
      of validation.chain
    ) {
      await insertBlockWithClient(
        client,
        block
      );
    }

    koala.chain =
      validation.chain;

    koala.totalMined =
      validation.totalMined;

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
// MIGRATION / RESTAURATION POSTGRESQL
// ============================================================

async function migrateHashFormat() {
  if (!USE_DATABASE) {
    return;
  }

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
      result.rows.length === 0
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
      i < result.rows.length;
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
        Number(row.nonce);

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

          pendingTransactions:
            Array.isArray(
              oldState.pendingTransactions
            )
              ? oldState.pendingTransactions
              : []
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

async function ensureHashFormat() {
  if (!USE_DATABASE) {
    return;
  }

  const blocks =
    await pool.query(`
      SELECT
        COUNT(*)::integer AS count

      FROM koa_blocks
    `);

  if (
    Number(
      blocks.rows[0].count
    ) === 0
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

async function restoreBlockchain() {
  if (!USE_DATABASE) {
    return;
  }

  const result =
    await pool.query(`
      SELECT *
      FROM koa_blocks
      ORDER BY block_index ASC
    `);

  if (
    result.rows.length === 0
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
      blockFromRow
    );

  const state =
    await getStoredState();

  koala.totalMined =
    calculateTotalMined();

  koala.pendingTransactions =
    Array.isArray(
      state.pendingTransactions
    )
      ? state.pendingTransactions.map(
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
// SYNCHRONISATION DU NŒUD MÉMOIRE
// ============================================================

async function syncFromBootstrap() {
  if (USE_DATABASE) {
    return;
  }

  const bootstrap =
    normalizeNodeUrl(
      BOOTSTRAP_NODE
    );

  if (!bootstrap) {
    throw new Error(
      "BOOTSTRAP_NODE obligatoire sur un nœud sans PostgreSQL."
    );
  }

  if (
    NODE_URL &&
    sameNode(
      bootstrap,
      NODE_URL
    )
  ) {
    throw new Error(
      "BOOTSTRAP_NODE ne peut pas être ce même nœud."
    );
  }

  console.log(
    `Synchronisation depuis : ${bootstrap}`
  );

  const data =
    await fetchJson(
      `${bootstrap}/api/chain`,
      {},
      15000
    );

  if (
    !data ||
    !Array.isArray(data.chain)
  ) {
    throw new Error(
      "Réponse BOOTSTRAP_NODE invalide."
    );
  }

  const validation =
    validateExternalChain(
      data.chain
    );

  if (!validation.valid) {
    throw new Error(
      "Blockchain du BOOTSTRAP_NODE invalide."
    );
  }

  // Remplace le Genesis aléatoire
  // créé localement.

  koala.chain =
    validation.chain;

  koala.totalMined =
    validation.totalMined;

  koala.pendingTransactions =
    [];

  synchronized = true;

  await registerNode(
    bootstrap
  );

  console.log(
    `Synchronisation : OK (${koala.chain.length} blocs)`
  );

  console.log(
    `KOA synchronisés : ${koala.totalMined}`
  );
}

// ============================================================
// ENREGISTREMENT AUTOMATIQUE DU NŒUD
// ============================================================

async function registerWithBootstrap() {
  const bootstrap =
    normalizeNodeUrl(
      BOOTSTRAP_NODE
    );

  const currentNode =
    normalizeNodeUrl(
      NODE_URL
    );

  // Le nœud principal n'a normalement
  // pas de BOOTSTRAP_NODE.

  if (
    !bootstrap ||
    !currentNode
  ) {
    console.log(
      "Enregistrement réseau automatique : ignoré"
    );

    return;
  }

  if (
    sameNode(
      bootstrap,
      currentNode
    )
  ) {
    console.log(
      "Enregistrement réseau automatique : nœud principal"
    );

    return;
  }

  console.log(
    `Enregistrement auprès du nœud principal : ${bootstrap}`
  );

  try {
    await fetchJson(
      `${bootstrap}/api/nodes/broadcast`,

      {
        method: "POST",

        body: JSON.stringify({
          nodeUrl:
            currentNode
        })
      },

      15000
    );

    // Conserve également le bootstrap
    // dans la liste locale du nœud 2.

    await registerNode(
      bootstrap
    );

    console.log(
      "Enregistrement réseau automatique : OK"
    );

    console.log(
      `${currentNode} <-> ${bootstrap}`
    );
  } catch (error) {
    // Une panne temporaire du nœud principal
    // ne doit pas empêcher le nœud de démarrer.

    console.error(
      "Enregistrement réseau automatique : ÉCHEC -",
      error.message
    );
  }
}

// ============================================================
// TRANSACTIONS
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
    transaction.signature || ""
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
              method: "POST",

              body:
                JSON.stringify({
                  transaction
                })
            }
          )
      )
    );

  return results.map(
    (result, index) => ({
      node:
        nodes[index],

      success:
        result.status ===
        "fulfilled",

      error:
        result.status ===
        "rejected"
          ? result.reason?.message
          : null
    })
  );
}

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
              method: "POST",

              body:
                JSON.stringify({
                  block
                })
            }
          )
      )
    );

  return results.map(
    (result, index) => ({
      node:
        nodes[index],

      success:
        result.status ===
        "fulfilled",

      error:
        result.status ===
        "rejected"
          ? result.reason?.message
          : null
    })
  );
}

// ============================================================
// ROUTES DE BASE
// ============================================================

app.get(
  "/health",
  (req, res) => {
    res.json({
      ok: true,

      storage:
        USE_DATABASE
          ? "postgresql"
          : "memory",

      database:
        databaseReady,

      synchronized,

      blockchain:
        koala.name,

      symbol:
        koala.symbol,

      node:
        NODE_URL || null,

      bootstrapNode:
        BOOTSTRAP_NODE || null,

      network: true
    });
  }
);

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

        storage:
          USE_DATABASE
            ? "postgresql"
            : "memory",

        database:
          databaseReady,

        synchronized,

        node:
          NODE_URL || null,

        bootstrapNode:
          BOOTSTRAP_NODE || null,

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
      res.status(500).json({
        error:
          error.message
      });
    }
  }
);

app.get(
  "/api/chain",
  (req, res) => {
    res.json({
      name:
        koala.name,

      symbol:
        koala.symbol,

      node:
        NODE_URL || null,

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
    const block =
      koala.chain.find(
        item =>
          item.index ===
          Number(
            req.params.index
          )
      );

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

app.post(
  "/api/wallet",
  (req, res) => {
    try {
      const wallet =
        createWallet();

      res.json({
        success: true,

        symbol: "KOA",

        address:
          wallet.address,

        publicKey:
          wallet.publicKey,

        privateKey:
          wallet.privateKey,

        balance: 0,

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

app.get(
  "/api/balance/:address",
  (req, res) => {
    res.json({
      address:
        req.params.address,

      symbol:
        koala.symbol,

      balance:
        koala.getBalanceOfAddress(
          req.params.address
        )
    });
  }
);

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
      koala.getTransactionsForAddress(
        req.params.address
      )
    );
  }
);

// ============================================================
// CRÉATION TRANSACTION
// ============================================================

app.post(
  "/api/transactions",
  async (req, res) => {
    try {
      if (!synchronized) {
        return res
          .status(503)
          .json({
            success: false,
            error:
              "Nœud non synchronisé."
          });
      }

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

      if (
        Math.abs(
          Date.now() -
            numericTimestamp
        ) >
        10 * 60 * 1000
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
// TRANSACTION RÉSEAU
// ============================================================

app.post(
  "/api/network/transaction",
  async (req, res) => {
    try {
      if (!synchronized) {
        return res
          .status(503)
          .json({
            success: false,
            error:
              "Nœud non synchronisé."
          });
      }

      const raw =
        req.body?.transaction;

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
// MINAGE
// ============================================================

app.post(
  "/api/mine",
  async (req, res) => {
    try {
      if (!synchronized) {
        return res
          .status(503)
          .json({
            success: false,

            error:
              "Nœud non synchronisé. Minage interdit."
          });
      }

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
          ...koala.pendingTransactions
        ];

      const previousTotal =
        koala.totalMined;

      const result =
        koala.minePendingTransactions(
          minerAddress
        );

      try {
        await saveBlock(
          result.block
        );

        await saveState();
      } catch (
        storageError
      ) {
        koala.chain.pop();

        koala.pendingTransactions =
          previousPending;

        koala.totalMined =
          previousTotal;

        throw storageError;
      }

      const network =
        await broadcastBlock(
          result.block
        );

      res.json({
        success: true,

        message:
          "Nouveau bloc KOA créé et diffusé au réseau.",

        reward:
          result.reward,

        minerAddress,

        balance:
          koala.getBalanceOfAddress(
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
// BLOC RÉSEAU
// ============================================================

app.post(
  "/api/network/block",
  async (req, res) => {
    try {
      if (!synchronized) {
        return res
          .status(503)
          .json({
            success: false,

            syncRequired: true,

            error:
              "Nœud non synchronisé."
          });
      }

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

      const validation =
        validateExternalChain([
          ...koala.chain,
          incomingBlock
        ]);

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

      const confirmedIds =
        new Set(
          incomingBlock.transactions

            .filter(
              tx =>
                tx.fromAddress !==
                null
            )

            .map(
              transactionId
            )
        );

      koala.pendingTransactions =
        previousPending.filter(
          tx =>
            !confirmedIds.has(
              transactionId(tx)
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
// NŒUDS
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
          NODE_URL || null,

        storage:
          USE_DATABASE
            ? "postgresql"
            : "memory",

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

app.post(
  "/api/nodes/register",
  async (req, res) => {
    try {
      const result =
        await registerNode(
          req.body?.nodeUrl
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
                method: "POST",

                body:
                  JSON.stringify({
                    nodeUrl:
                      newNode
                  })
              }
            )
        )
      );

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
              method: "POST",

              body:
                JSON.stringify({
                  nodeUrl:
                    node
                })
            }
          );
        } catch (error) {
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

app.get(
  "/api/validate",
  (req, res) => {
    res.json({
      valid:
        koala.isChainValid(),

      synchronized,

      storage:
        USE_DATABASE
          ? "postgresql"
          : "memory",

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
// DÉMARRAGE
// ============================================================

async function start() {
  try {
    if (USE_DATABASE) {
      console.log(
        "Mode stockage : PostgreSQL"
      );

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

      await ensureHashFormat();

      await restoreBlockchain();

      if (
        !koala.isChainValid()
      ) {
        throw new Error(
          "Blockchain PostgreSQL invalide après restauration."
        );
      }

      await saveState();

      databaseReady = true;
      synchronized = true;
    } else {
      console.log(
        "Mode stockage : mémoire"
      );

      console.log(
        "PostgreSQL : NON"
      );

      console.log(
        "Aucune nouvelle blockchain KOA ne sera créée."
      );

      // Le nœud mémoire récupère
      // le Genesis historique et toute
      // la chaîne depuis le bootstrap.

      await syncFromBootstrap();

      if (
        !koala.isChainValid()
      ) {
        throw new Error(
          "Blockchain invalide après synchronisation."
        );
      }
    }

    // ========================================================
    // NOUVEAU :
    // ENREGISTREMENT AUTOMATIQUE NŒUD 1 <-> NŒUD 2
    // ========================================================

    await registerWithBootstrap();

    // ========================================================
    // SERVEUR HTTP
    // ========================================================

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
          `NODE_URL : ${
            NODE_URL ||
            "NON CONFIGURÉ"
          }`
        );

        console.log(
          `BOOTSTRAP_NODE : ${
            BOOTSTRAP_NODE ||
            "NON CONFIGURÉ"
          }`
        );

        console.log(
          `Stockage : ${
            USE_DATABASE
              ? "PostgreSQL"
              : "mémoire"
          }`
        );

        console.log(
          `Synchronisé : ${
            synchronized
              ? "OUI"
              : "NON"
          }`
        );

        console.log(
          "Clé privée dans /api/transactions : NON"
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