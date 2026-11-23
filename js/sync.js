// js/sync.js
// Bergantung pada js/db.js (db & SeedHelper)

const SYNC_CONFIG_KEY = "simpatik_sfa_sync_config";
const OPERATIONAL_TABLES = [
  "djo_shifts",
  "visits",
  "transactions",
  "returns",
  "debt_payments",
  "vehicle_stock_movements",
  "expenses"
];
const MASTER_TABLES = [
  "users",
  "products",
  "outlets",
  "vehicles",
  "no_order_reasons",
  "expense_categories"
];

const SyncHelper = {
  getConfig() {
    try {
      const raw = localStorage.getItem(SYNC_CONFIG_KEY);
      return raw ? JSON.parse(raw) : { endpointUrl: "", apiKey: "", lastSyncAt: null };
    } catch (err) {
      return { endpointUrl: "", apiKey: "", lastSyncAt: null };
    }
  },

  saveConfig({ endpointUrl = "", apiKey = "" }) {
    const prev = this.getConfig();
    const next = {
      ...prev,
      endpointUrl: String(endpointUrl || "").trim(),
      apiKey: String(apiKey || "").trim()
    };
    localStorage.setItem(SYNC_CONFIG_KEY, JSON.stringify(next));
    return next;
  },

  /**
   * Menghitung jumlah catatan operasional lokal yang belum tersinkronisasi (synced === 0)
   */
  async countPendingRecords() {
    let totalPending = 0;
    const perTable = {};

    for (const tableName of OPERATIONAL_TABLES) {
      const rows = await db[tableName].toArray();
      const pending = rows.filter((r) => Number(r.synced ?? 0) === 0).length;
      perTable[tableName] = pending;
      totalPending += pending;
    }

    return { totalPending, perTable };
  },

  /**
   * Mengirim catatan operasional yang belum tersinkronisasi ke endpoint cloud
   */
  async pushPendingChanges() {
    const cfg = this.getConfig();
    if (!cfg.endpointUrl) {
      throw new Error("URL endpoint sinkronisasi belum diatur. Gunakan Backup/Restore JSON atau isi URL endpoint terlebih dahulu.");
    }

    const payload = {
      pushed_at: new Date().toISOString(),
      records: {}
    };

    for (const tableName of OPERATIONAL_TABLES) {
      const rows = await db[tableName].toArray();
      payload.records[tableName] = rows.filter((r) => Number(r.synced ?? 0) === 0);
    }

    const headers = { "Content-Type": "application/json" };
    if (cfg.apiKey) headers["Authorization"] = `Bearer ${cfg.apiKey}`;

    const res = await fetch(`${cfg.endpointUrl.replace(/\/+$/, "")}/push`, {
      method: "POST",
      headers,
      body: JSON.stringify(payload)
    });

    if (!res.ok) {
      throw new Error(`Gagal sinkronisasi ke server (HTTP ${res.status}).`);
    }

    // Tandai seluruh record pending sebagai synced = 1
    for (const tableName of OPERATIONAL_TABLES) {
      const pendingRows = payload.records[tableName] || [];
      for (const row of pendingRows) {
        if (row.id !== undefined) {
          await db[tableName].update(row.id, { synced: 1 });
        }
      }
    }

    const updatedCfg = { ...cfg, lastSyncAt: new Date().toISOString() };
    localStorage.setItem(SYNC_CONFIG_KEY, JSON.stringify(updatedCfg));
    return payload;
  },

  /**
   * Menarik pembaruan Master Data dari server endpoint (jika tersedia)
   */
  async pullMasterData() {
    const cfg = this.getConfig();
    if (!cfg.endpointUrl) {
      throw new Error("URL endpoint sinkronisasi belum diatur.");
    }

    const headers = {};
    if (cfg.apiKey) headers["Authorization"] = `Bearer ${cfg.apiKey}`;

    const res = await fetch(`${cfg.endpointUrl.replace(/\/+$/, "")}/master`, {
      method: "GET",
      headers
    });

    if (!res.ok) {
      throw new Error(`Gagal menarik Master Data dari server (HTTP ${res.status}).`);
    }

    const data = await res.json();
    for (const tableName of MASTER_TABLES) {
      const items = Array.isArray(data[tableName]) ? data[tableName] : [];
      if (items.length > 0) {
        await db[tableName].clear();
        await db[tableName].bulkAdd(items);
      }
    }

    const updatedCfg = { ...cfg, lastSyncAt: new Date().toISOString() };
    localStorage.setItem(SYNC_CONFIG_KEY, JSON.stringify(updatedCfg));
    return true;
  },

  /**
   * Mengekspor seluruh isi database lokal menjadi file JSON backup
   */
  async exportBackupJson() {
    const allTables = [...MASTER_TABLES, ...OPERATIONAL_TABLES];
    const dump = {
      app: "SIMPATIK_SFA",
      version: 1,
      exported_at: new Date().toISOString(),
      tables: {}
    };

    for (const tableName of allTables) {
      dump.tables[tableName] = await db[tableName].toArray();
    }

    const blob = new Blob([JSON.stringify(dump, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const fileName = `Backup_SIMPATIK_SFA_${new Date().toISOString().slice(0, 10)}.json`;

    const a = document.createElement("a");
    a.href = url;
    a.download = fileName;
    a.click();
    URL.revokeObjectURL(url);

    return fileName;
  },

  /**
   * Memulihkan database lokal dari file JSON backup
   */
  async importBackupJson(file) {
    if (!file) throw new Error("File backup JSON belum dipilih.");
    const text = await file.text();
    const parsed = JSON.parse(text);

    if (!parsed || !parsed.tables || typeof parsed.tables !== "object") {
      throw new Error("Format file backup JSON tidak valid.");
    }

    const allTables = [...MASTER_TABLES, ...OPERATIONAL_TABLES];
    await db.transaction("rw", allTables.map((t) => db[t]), async () => {
      for (const tableName of allTables) {
        if (Array.isArray(parsed.tables[tableName])) {
          await db[tableName].clear();
          if (parsed.tables[tableName].length > 0) {
            await db[tableName].bulkPut(parsed.tables[tableName]);
          }
        }
      }
    });

    return true;
  }
};

window.SyncHelper = SyncHelper;
