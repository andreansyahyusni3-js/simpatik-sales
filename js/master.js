// js/master.js
// Bergantung pada js/db.js (db, UnitConverter, PricingHelper, SeedHelper)

/**
 * Helper generate kode berurut otomatis (misal: PRD-001, TKO-001, KND-001, USR-SLS-001)
 */
async function generateNextCode(tableName, fieldName, prefix, digits = 3) {
  const rows = await db[tableName].toArray();
  let maxNum = 0;
  const regex = new RegExp(`^${prefix}-(\\d+)$`, "i");

  for (const row of rows) {
    const val = String(row[fieldName] || "").trim();
    const match = val.match(regex);
    if (match) {
      const num = parseInt(match[1], 10);
      if (num > maxNum) maxNum = num;
    }
  }

  const nextNum = String(maxNum + 1).padStart(digits, "0");
  return `${prefix}-${nextNum}`;
}

const MasterHelper = {
  /**
   * Mengecek status servis dan surat-menyurat kendaraan untuk monitoring Admin
   */
  evaluateVehicleStatus(vehicle = {}) {
    const kmSekarang = Number(vehicle.km_terakhir || 0);
    const kmServisTerakhir = Number(vehicle.km_servis_terakhir || 0);
    const intervalKm = Number(vehicle.interval_km_servis || 5000);
    const nextKmServis = kmServisTerakhir + intervalKm;
    const sisaKmServis = nextKmServis - kmSekarang;

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const parseDate = (val) => {
      if (!val) return null;
      const d = new Date(val + (val.length === 10 ? "T00:00:00" : ""));
      return Number.isNaN(d.getTime()) ? null : d;
    };

    const daysUntil = (dateStr) => {
      const target = parseDate(dateStr);
      if (!target) return null;
      const diffMs = target.getTime() - today.getTime();
      return Math.ceil(diffMs / (1000 * 60 * 60 * 24));
    };

    const alerts = [];

    // Cek KM Servis
    if (sisaKmServis <= 0) {
      alerts.push(`Lewat batas KM servis (${sisaKmServis} km)`);
    } else if (sisaKmServis <= 500) {
      alerts.push(`Mendekati KM servis (sisa ${sisaKmServis} km)`);
    }

    // Cek Tanggal Servis Berikutnya
    const daysServis = daysUntil(vehicle.tanggal_servis_berikutnya);
    if (daysServis !== null) {
      if (daysServis < 0) alerts.push(`Jadwal servis lewat ${Math.abs(daysServis)} hari`);
      else if (daysServis <= 7) alerts.push(`Jadwal servis ${daysServis} hari lagi`);
    }

    // Cek Surat-Menyurat Kendaraan
    const docs = [
      { label: "STNK Tahunan", val: vehicle.stnk_tahunan },
      { label: "STNK 5 Tahunan", val: vehicle.stnk_lima_tahunan },
      { label: "KIR", val: vehicle.kir_berlaku_sampai },
      { label: "Asuransi", val: vehicle.asuransi_berlaku_sampai }
    ];

    for (const doc of docs) {
      const sisaHari = daysUntil(doc.val);
      if (sisaHari === null) continue;
      if (sisaHari < 0) {
        alerts.push(`${doc.label} mati/lewat ${Math.abs(sisaHari)} hari`);
      } else if (sisaHari <= 30) {
        alerts.push(`${doc.label} habis dalam ${sisaHari} hari`);
      }
    }

    let statusArmada = "AMAN";
    if (alerts.some((a) => a.includes("Lewat") || a.includes("mati/lewat"))) {
      statusArmada = "PERHATIAN_KRITIS";
    } else if (alerts.length > 0) {
      statusArmada = "MENDEKATI_JATUH_TEMPO";
    }

    return {
      nextKmServis,
      sisaKmServis,
      statusArmada,
      alerts
    };
  },

  // ---------------- USERS ----------------
  async getUsers() {
    return await db.users.orderBy("id").toArray();
  },

  async saveUser(data, id = null) {
    const roleVal = data.role === "admin" ? "admin" : "sales";
    const prefixUser = roleVal === "admin" ? "USR-ADM" : "USR-SLS";

    let kodeUser = String(data.kode_user || "").trim().toUpperCase();
    if (!id && !kodeUser) {
      kodeUser = await generateNextCode("users", "kode_user", prefixUser, 3);
    }

    const payload = {
      kode_user: kodeUser,
      nama: String(data.nama || "").trim(),
      username: String(data.username || "").trim().toLowerCase(),
      pin_atau_pass: String(data.pin_atau_pass || "").trim(),
      role: roleVal,
      kode_rute: String(data.kode_rute || "").trim().toUpperCase(),
      kendaraan_id: data.kendaraan_id ? Number(data.kendaraan_id) : null,
      status_aktif: data.status_aktif === "nonaktif" ? "nonaktif" : "aktif"
    };

    if (!payload.kode_user || !payload.nama || !payload.username) {
      throw new Error("Nama Lengkap dan Username wajib diisi.");
    }

    if (id) {
      await db.users.update(Number(id), payload);
      return Number(id);
    }

    if (!payload.pin_atau_pass) payload.pin_atau_pass = "1234";
    return await db.users.add(payload);
  },

  async deleteUser(id) {
    return await db.users.delete(Number(id));
  },

  // ---------------- PRODUCTS ----------------
  async getProducts() {
    return await db.products.orderBy("id").toArray();
  },

  async saveProduct(data, id = null) {
    let skuKode = String(data.sku_kode || "").trim().toUpperCase();
    if (!id && !skuKode) {
      skuKode = await generateNextCode("products", "sku_kode", "PRD", 3);
    }

    const payload = {
      sku_kode: skuKode,
      nama_produk: String(data.nama_produk || "").trim(),
      kategori_lini: String(data.kategori_lini || "Umum").trim(),
      satuan_besar_utama: String(data.satuan_besar_utama || "karton").trim(),
      satuan_kecil: "bungkus",
      isi_per_slop: Number(data.isi_per_slop || 10),
      slop_per_bal: Number(data.slop_per_bal || 20),
      bal_per_karton: Number(data.bal_per_karton || 4),
      harga_ritel: Number(data.harga_ritel || 0),
      harga_grosir: Number(data.harga_grosir || 0),
      harga_star_outlet: Number(data.harga_star_outlet || 0),
      status_aktif: data.status_aktif === "nonaktif" ? "nonaktif" : "aktif"
    };

    if (!payload.sku_kode || !payload.nama_produk) {
      throw new Error("Nama Produk wajib diisi.");
    }

    if (id) {
      await db.products.update(Number(id), payload);
      return Number(id);
    }

    return await db.products.add(payload);
  },

  async deleteProduct(id) {
    return await db.products.delete(Number(id));
  },

  // ---------------- OUTLETS ----------------
  async getOutlets() {
    return await db.outlets.orderBy("id").toArray();
  },

  async saveOutlet(data, id = null) {
    let kodeToko = String(data.kode_toko || "").trim().toUpperCase();
    if (!id && !kodeToko) {
      kodeToko = await generateNextCode("outlets", "kode_toko", "TKO", 3);
    }

    const jadwalArray = Array.isArray(data.jadwal_hari)
      ? data.jadwal_hari
      : String(data.jadwal_hari || "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);

    const payload = {
      kode_toko: kodeToko,
      nama_toko: String(data.nama_toko || "").trim(),
      nama_pemilik: String(data.nama_pemilik || "").trim(),
      alamat: String(data.alamat || "").trim(),
      koordinat_gps: {
        lat: data.lat !== "" && data.lat !== undefined ? Number(data.lat) : null,
        lng: data.lng !== "" && data.lng !== undefined ? Number(data.lng) : null
      },
      tier_harga: ["ritel", "grosir", "star_outlet"].includes(data.tier_harga)
        ? data.tier_harga
        : "ritel",
      jadwal_hari: jadwalArray,
      kode_djo: String(data.kode_djo || "").trim().toUpperCase(),
      urutan_rute: Number(data.urutan_rute || 0),
      sales_id: data.sales_id ? Number(data.sales_id) : null,
      izinkan_kredit: Boolean(data.izinkan_kredit),
      limit_kredit: Number(data.limit_kredit || 0),
      sisa_piutang_aktif: Number(data.sisa_piutang_aktif || 0),
      status_toko: data.status_toko || "aktif"
    };

    if (!payload.kode_toko || !payload.nama_toko) {
      throw new Error("Nama Toko wajib diisi.");
    }

    if (id) {
      await db.outlets.update(Number(id), payload);
      return Number(id);
    }

    return await db.outlets.add(payload);
  },

  async deleteOutlet(id) {
    return await db.outlets.delete(Number(id));
  },

  // ---------------- VEHICLES ----------------
  async getVehicles() {
    return await db.vehicles.orderBy("id").toArray();
  },

  async saveVehicle(data, id = null) {
    let kodeKendaraan = String(data.kode_kendaraan || "").trim().toUpperCase();
    if (!id && !kodeKendaraan) {
      kodeKendaraan = await generateNextCode("vehicles", "kode_kendaraan", "KND", 3);
    }

    const payload = {
      kode_kendaraan: kodeKendaraan,
      plat_nomor: String(data.plat_nomor || "").trim().toUpperCase(),
      nama_kendaraan: String(data.nama_kendaraan || "").trim(),
      sales_id: data.sales_id ? Number(data.sales_id) : null,
      km_terakhir: Number(data.km_terakhir || 0),
      km_servis_terakhir: Number(data.km_servis_terakhir || 0),
      interval_km_servis: Number(data.interval_km_servis || 5000),
      tanggal_servis_terakhir: data.tanggal_servis_terakhir || "",
      tanggal_servis_berikutnya: data.tanggal_servis_berikutnya || "",
      catatan_servis: String(data.catatan_servis || "").trim(),
      stnk_tahunan: data.stnk_tahunan || "",
      stnk_lima_tahunan: data.stnk_lima_tahunan || "",
      kir_berlaku_sampai: data.kir_berlaku_sampai || "",
      asuransi_berlaku_sampai: data.asuransi_berlaku_sampai || "",
      catatan_dokumen: String(data.catatan_dokumen || "").trim(),
      status_aktif: data.status_aktif || "aktif"
    };

    if (!payload.kode_kendaraan || !payload.plat_nomor) {
      throw new Error("Plat Nomor wajib diisi.");
    }

    if (id) {
      await db.vehicles.update(Number(id), payload);
      return Number(id);
    }

    return await db.vehicles.add(payload);
  },

  async deleteVehicle(id) {
    return await db.vehicles.delete(Number(id));
  },

  // ---------------- NO ORDER REASONS & EXPENSE CATEGORIES ----------------
  async getNoOrderReasons() {
    return await db.no_order_reasons.orderBy("id").toArray();
  },

  async saveNoOrderReason(data, id = null) {
    const payload = {
      kode_alasan: String(data.kode_alasan || "").trim().toUpperCase(),
      label_alasan: String(data.label_alasan || "").trim(),
      dihitung_kunjungan_valid: Boolean(data.dihitung_kunjungan_valid),
      status_aktif: data.status_aktif === "nonaktif" ? "nonaktif" : "aktif"
    };
    if (!payload.kode_alasan || !payload.label_alasan) {
      throw new Error("Kode Alasan dan Label Alasan wajib diisi.");
    }
    if (id) return await db.no_order_reasons.update(Number(id), payload);
    return await db.no_order_reasons.add(payload);
  },

  async getExpenseCategories() {
    return await db.expense_categories.orderBy("id").toArray();
  },

  async saveExpenseCategory(data, id = null) {
    const payload = {
      kode_biaya: String(data.kode_biaya || "").trim().toUpperCase(),
      nama_biaya: String(data.nama_biaya || "").trim(),
      status_aktif: data.status_aktif === "nonaktif" ? "nonaktif" : "aktif"
    };
    if (!payload.kode_biaya || !payload.nama_biaya) {
      throw new Error("Kode Biaya dan Nama Biaya wajib diisi.");
    }
    if (id) return await db.expense_categories.update(Number(id), payload);
    return await db.expense_categories.add(payload);
  }
};

window.MasterHelper = MasterHelper;
