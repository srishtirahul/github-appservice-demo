// server.js
// Simple CRUD API — Node.js + Express + Azure SQL Database
// Deployed as its own Azure App Service (backend tier)

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const sql = require('mssql');

const app = express();
app.use(cors());
app.use(express.json());

// ---- Database config ----
// In PHASE 1 (POC) these come from env vars set directly on App Service.
// In PHASE 2 (production) these will come from Key Vault references instead.
const dbConfig = {
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  server: process.env.DB_SERVER,       // e.g. yourserver.database.windows.net
  database: process.env.DB_NAME,       // e.g. pocdb
  options: {
    encrypt: true,               // required for Azure SQL
    trustServerCertificate: false
  },
  pool: { max: 10, min: 0, idleTimeoutMillis: 30000 }
};

let pool;
async function getPool() {
  if (!pool) {
    pool = await sql.connect(dbConfig);
  }
  return pool;
}

// ---- Health check (used by App Service / App Gateway probes later) ----
app.get('/api/health', (req, res) => {
  res.status(200).json({ status: 'ok' });
});

// ---- CREATE ----
app.post('/api/items', async (req, res) => {
  try {
    const { name, description } = req.body;
    const p = await getPool();
    const result = await p.request()
      .input('name', sql.NVarChar(200), name)
      .input('description', sql.NVarChar(1000), description || '')
      .query(`INSERT INTO Items (Name, Description, CreatedAt)
              OUTPUT INSERTED.*
              VALUES (@name, @description, GETUTCDATE())`);
    res.status(201).json(result.recordset[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create item' });
  }
});

// ---- READ (all) ----
app.get('/api/items', async (req, res) => {
  try {
    const p = await getPool();
    const result = await p.request().query('SELECT * FROM Items ORDER BY CreatedAt DESC');
    res.json(result.recordset);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch items' });
  }
});

// ---- READ (one) ----
app.get('/api/items/:id', async (req, res) => {
  try {
    const p = await getPool();
    const result = await p.request()
      .input('id', sql.Int, req.params.id)
      .query('SELECT * FROM Items WHERE Id = @id');
    if (!result.recordset.length) return res.status(404).json({ error: 'Not found' });
    res.json(result.recordset[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch item' });
  }
});

// ---- UPDATE ----
app.put('/api/items/:id', async (req, res) => {
  try {
    const { name, description } = req.body;
    const p = await getPool();
    const result = await p.request()
      .input('id', sql.Int, req.params.id)
      .input('name', sql.NVarChar(200), name)
      .input('description', sql.NVarChar(1000), description || '')
      .query(`UPDATE Items SET Name = @name, Description = @description
              OUTPUT INSERTED.*
              WHERE Id = @id`);
    if (!result.recordset.length) return res.status(404).json({ error: 'Not found' });
    res.json(result.recordset[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update item' });
  }
});

// ---- DELETE ----
app.delete('/api/items/:id', async (req, res) => {
  try {
    const p = await getPool();
    await p.request()
      .input('id', sql.Int, req.params.id)
      .query('DELETE FROM Items WHERE Id = @id');
    res.status(204).send();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete item' });
  }
});

const PORT = process.env.PORT || 8080; // Azure App Service injects PORT
app.listen(PORT, () => console.log(`Backend API running on port ${PORT}`));
