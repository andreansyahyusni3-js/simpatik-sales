// js/auth.js
// Bergantung pada js/db.js (db & SeedHelper)

const SESSION_KEY = "simpatik_sfa_session";

function normalizeRole(role) {
  return String(role || "").trim().toLowerCase();
}

const AuthHelper = {
  /**
   * Memastikan database siap dan data default sudah terisi
   */
  async init() {
    if (!window.db) {
      throw new Error("Database (db.js) belum dimuat.");
    }
    if (!db.isOpen()) {
      await db.open();
    }
    if (window.SeedHelper && typeof SeedHelper.seedDefaults === "function") {
      await SeedHelper.seedDefaults();
    }
  },

  /**
   * Proses login berdasarkan username/kode_user dan pin_atau_pass
   */
  async login(identifier, credential) {
    await this.init();

    const cleanId = String(identifier || "").trim().toLowerCase();
    const cleanCred = String(credential || "").trim();

    if (!cleanId || !cleanCred) {
      return {
        ok: false,
        message: "Username/Kode User dan PIN/Password wajib diisi."
      };
    }

    const users = await db.users.toArray();
    const matched = users.find((u) => {
      const matchUsername = String(u.username || "").trim().toLowerCase() === cleanId;
      const matchKode = String(u.kode_user || "").trim().toLowerCase() === cleanId;
      const matchCred = String(u.pin_atau_pass || "").trim() === cleanCred;
      return (matchUsername || matchKode) && matchCred;
    });

    if (!matched) {
      return {
        ok: false,
        message: "Akun atau PIN/Password tidak ditemukan."
      };
    }

    const statusAktif = String(matched.status_aktif || "aktif").trim().toLowerCase();
    if (statusAktif !== "aktif") {
      return {
        ok: false,
        message: "Akun ini sedang nonaktif. Hubungi Admin."
      };
    }

    const role = normalizeRole(matched.role) || "sales";

    const sessionData = {
      user_id: matched.id,
      kode_user: matched.kode_user,
      nama: matched.nama,
      username: matched.username,
      role,
      kode_rute: matched.kode_rute || "",
      kendaraan_id: matched.kendaraan_id ?? null,
      login_at: new Date().toISOString()
    };

    localStorage.setItem(SESSION_KEY, JSON.stringify(sessionData));

    return {
      ok: true,
      user: sessionData,
      redirectTo: role === "admin" ? "admin.html" : "sales.html"
    };
  },

  /**
   * Mengambil data sesi pengguna yang sedang login
   */
  getSession() {
    try {
      const raw = localStorage.getItem(SESSION_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || !parsed.role) return null;
      parsed.role = normalizeRole(parsed.role);
      return parsed;
    } catch (err) {
      return null;
    }
  },

  /**
   * Logout dan menghapus sesi aktif
   */
  logout(redirectTo = "index.html") {
    localStorage.removeItem(SESSION_KEY);
    if (redirectTo && !window.location.pathname.endsWith(redirectTo)) {
      window.location.replace(redirectTo);
    }
  },

  /**
   * Guard halaman: memastikan user sudah login dan memiliki role yang sesuai.
   */
  async requireRole(expectedRole = null) {
    try {
      await this.init();
    } catch (err) {
      console.error("Auth init error:", err);
      return null;
    }

    const session = this.getSession();
    const targetRole = expectedRole ? normalizeRole(expectedRole) : null;

    if (!session || !session.role) {
      if (!window.location.pathname.endsWith("index.html")) {
        window.location.replace("index.html");
      }
      return null;
    }

    if (targetRole && session.role !== targetRole) {
      const dest = session.role === "admin" ? "admin.html" : "sales.html";
      if (!window.location.pathname.endsWith(dest)) {
        window.location.replace(dest);
      }
      return null;
    }

    return session;
  },

  /**
   * Jika sudah login di index.html, arahkan sekali ke dashboard sesuai role
   */
  async redirectIfAuthenticated() {
    try {
      await this.init();
    } catch (err) {
      console.error("Auth init error:", err);
      return false;
    }

    const session = this.getSession();
    if (!session || !session.role) return false;

    const dest = session.role === "admin" ? "admin.html" : "sales.html";
    if (!window.location.pathname.endsWith(dest)) {
      window.location.replace(dest);
      return true;
    }
    return false;
  }
};

window.AuthHelper = AuthHelper;
