// js/auth.js
// Bergantung pada js/db.js (db & SeedHelper)

const SESSION_KEY = "simpatik_sfa_session";

const AuthHelper = {
  /**
   * Memastikan database siap dan data default sudah terisi
   */
  async init() {
    if (!window.db) {
      throw new Error("Database (db.js) belum dimuat.");
    }
    await db.open();
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

    if (matched.status_aktif !== "aktif") {
      return {
        ok: false,
        message: "Akun ini sedang nonaktif. Hubungi Admin."
      };
    }

    const sessionData = {
      user_id: matched.id,
      kode_user: matched.kode_user,
      nama: matched.nama,
      username: matched.username,
      role: matched.role, // "admin" | "sales"
      kode_rute: matched.kode_rute || "",
      kendaraan_id: matched.kendaraan_id ?? null,
      login_at: new Date().toISOString()
    };

    localStorage.setItem(SESSION_KEY, JSON.stringify(sessionData));

    return {
      ok: true,
      user: sessionData,
      redirectTo: matched.role === "admin" ? "admin.html" : "sales.html"
    };
  },

  /**
   * Mengambil data sesi pengguna yang sedang login
   */
  getSession() {
    try {
      const raw = localStorage.getItem(SESSION_KEY);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch (err) {
      return null;
    }
  },

  /**
   * Logout dan menghapus sesi aktif
   */
  logout(redirectTo = "index.html") {
    localStorage.removeItem(SESSION_KEY);
    if (redirectTo) {
      window.location.href = redirectTo;
    }
  },

  /**
   * Guard halaman: memastikan user sudah login dan memiliki role yang sesuai.
   * Jika tidak sesuai, diarahkan ke index.html atau halaman perannya.
   */
  async requireRole(expectedRole = null) {
    await this.init();
    const session = this.getSession();

    if (!session || !session.role) {
      window.location.href = "index.html";
      return null;
    }

    if (expectedRole && session.role !== expectedRole) {
      window.location.href = session.role === "admin" ? "admin.html" : "sales.html";
      return null;
    }

    return session;
  },

  /**
   * Jika sudah login di index.html, langsung arahkan ke dashboard sesuai role
   */
  async redirectIfAuthenticated() {
    await this.init();
    const session = this.getSession();
    if (session && session.role === "admin") {
      window.location.href = "admin.html";
      return true;
    }
    if (session && session.role === "sales") {
      window.location.href = "sales.html";
      return true;
    }
    return false;
  }
};

window.AuthHelper = AuthHelper;
