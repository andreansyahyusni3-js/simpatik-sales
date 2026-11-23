// js/db.js
// Pastikan Dexie.js dimuat sebelum file ini:
// <script src="https://unpkg.com/dexie@3/dist/dexie.js"></script>

const db = new Dexie("SimpatikSFA_DB");

// Versi 1: Master Data + Operasional Lapangan + Retur + Piutang + Armada
db.version(1).stores({
  // Master Data
  users: "++id, kode_user, nama, username, role, kode_rute, kendaraan_id, status_aktif",
  products: "++id, sku_kode, nama_produk, kategori_lini, status_aktif",
  outlets: "++id, kode_toko, nama_toko, kode_djo, sales_id, tier_harga, status_toko",
  vehicles: "++id, kode_kendaraan, plat_nomor, sales_id, status_aktif",
  no_order_reasons: "++id, kode_alasan, dihitung_kunjungan_valid, status_aktif",
  expense_categories: "++id, kode_biaya, status_aktif",

  // Operasional Harian & Rute (DJO)
  djo_shifts: "++id, kode_djo, tanggal, sales_id, asisten_nama, vehicle_id, status_shift, synced",
  visits: "++id, shift_id, tanggal, kode_djo, outlet_id, sales_id, status_kunjungan, reason_id, is_rescheduled, synced",
  transactions: "++id, no_nota, shift_id, visit_id, tanggal, outlet_id, sales_id, metode_bayar, status_bayar, synced",
  returns: "++id, no_retur, shift_id, visit_id, tanggal, outlet_id, sales_id, tipe_selisih, synced",
  debt_payments: "++id, no_bayar, transaction_id, outlet_id, sales_id, tanggal, metode_terima, synced",
  vehicle_stock_movements: "++id, shift_id, tanggal, vehicle_id, product_id, jenis_mutasi, synced",
  expenses: "++id, shift_id, tanggal, sales_id, category_id, metode_bayar, synced"
});

// =====================================================================
// KONVERSI SATUAN:
// 1 Slop   = 10 Bungkus
// 1 Bal    = 20 Slop    = 200 Bungkus
// 1 Karton = 4 Bal      = 80 Slop = 800 Bungkus
// =====================================================================
const UnitConverter = {
  /**
   * Mengubah input satuan besar & kecil menjadi total satuan terkecil (bungkus).
   * Default: 1 Karton = 4 Bal, 1 Bal = 20 Slop, 1 Slop = 10 Bungkus.
   */
  toBungkus({ karton = 0, bal = 0, slop = 0, bungkus = 0 }, product = {}) {
    const isiPerSlop = Number(product.isi_per_slop ?? 10);
    const slopPerBal = Number(product.slop_per_bal ?? 20);
    const balPerKarton = Number(product.bal_per_karton ?? 4);

    const bungkusPerSlop = isiPerSlop;
    const bungkusPerBal = slopPerBal * bungkusPerSlop;
    const bungkusPerKarton = balPerKarton * bungkusPerBal;

    return (
      Number(karton || 0) * bungkusPerKarton +
      Number(bal || 0) * bungkusPerBal +
      Number(slop || 0) * bungkusPerSlop +
      Number(bungkus || 0)
    );
  },

  /**
   * Memecah total bungkus menjadi rincian { karton, bal, slop, bungkus }
   */
  fromBungkus(totalBungkus = 0, product = {}) {
    const isiPerSlop = Number(product.isi_per_slop ?? 10);
    const slopPerBal = Number(product.slop_per_bal ?? 20);
    const balPerKarton = Number(product.bal_per_karton ?? 4);

    const bungkusPerSlop = isiPerSlop;
    const bungkusPerBal = slopPerBal * bungkusPerSlop;
    const bungkusPerKarton = balPerKarton * bungkusPerBal;

    const sign = totalBungkus < 0 ? -1 : 1;
    let sisa = Math.abs(Math.round(Number(totalBungkus || 0)));

    const karton = Math.floor(sisa / bungkusPerKarton);
    sisa %= bungkusPerKarton;

    const bal = Math.floor(sisa / bungkusPerBal);
    sisa %= bungkusPerBal;

    const slop = Math.floor(sisa / bungkusPerSlop);
    const bungkus = sisa % bungkusPerSlop;

    return {
      sign,
      karton: sign * karton,
      bal: sign * bal,
      slop: sign * slop,
      bungkus: sign * bungkus,
      totalBungkus: Number(totalBungkus || 0)
    };
  },

  /**
   * Format teks ringkas untuk tampilan UI/laporan, misal: "1 Karton, 2 Bal, 5 Slop"
   */
  formatLabel(totalBungkus = 0, product = {}) {
    const p = this.fromBungkus(totalBungkus, product);
    const parts = [];
    if (p.karton !== 0) parts.push(`${p.karton} Karton`);
    if (p.bal !== 0) parts.push(`${p.bal} Bal`);
    if (p.slop !== 0) parts.push(`${p.slop} Slop`);
    if (p.bungkus !== 0 || parts.length === 0) parts.push(`${p.bungkus} Bungkus`);
    return parts.join(", ");
  }
};

// =====================================================================
// KALKULASI HARGA TIER & SELISIH RETUR
// =====================================================================
const PricingHelper = {
  /**
   * Mengambil harga per bungkus berdasarkan tier toko ('ritel' | 'grosir' | 'star_outlet')
   */
  getHargaPerBungkus(product, tierHarga = "ritel") {
    switch (tierHarga) {
      case "grosir":
        return Number(product.harga_grosir ?? product.harga_ritel ?? 0);
      case "star_outlet":
        return Number(product.harga_star_outlet ?? product.harga_ritel ?? 0);
      case "ritel":
      default:
        return Number(product.harga_ritel ?? 0);
    }
  },

  /**
   * Menghitung nilai retur, nilai barang pengganti, dan selisihnya:
   * - selisih > 0  : harus dibayar toko ('bayar_toko')
   * - selisih < 0  : harus diganti sales ('ganti_sales')
   * - selisih === 0: impas ('impas')
   */
  hitungSelisihRetur(nilaiRetur = 0, nilaiPengganti = 0) {
    const retur = Number(nilaiRetur || 0);
    const ganti = Number(nilaiPengganti || 0);
    const selisih = ganti - retur;

    let tipe_selisih = "impas";
    if (selisih > 0) tipe_selisih = "bayar_toko";
    else if (selisih < 0) tipe_selisih = "ganti_sales";

    return {
      nilai_retur: retur,
      nilai_pengganti: ganti,
      selisih_nominal: Math.abs(selisih),
      selisih_bertanda: selisih,
      tipe_selisih
    };
  }
};

// =====================================================================
// HELPER SEED DATA AWAL (MASTER DATA DEFAULT)
// =====================================================================
const SeedHelper = {
  defaultUsers: [
    {
      kode_user: "USR-ADMIN-01",
      nama: "Admin Operasional",
      username: "admin",
      pin_atau_pass: "1234",
      role: "admin",
      kode_rute: "ALL",
      kendaraan_id: null,
      status_aktif: "aktif"
    },
    {
      kode_user: "USR-SALES-01",
      nama: "Sales Lapangan 01",
      username: "sales1",
      pin_atau_pass: "1234",
      role: "sales",
      kode_rute: "RUTE-01",
      kendaraan_id: 1,
      status_aktif: "aktif"
    }
  ],

  defaultVehicles: [
    {
      kode_kendaraan: "VEH-01",
      plat_nomor: "DA 0000 XX",
      nama_kendaraan: "Unit Operasional 01",
      sales_id: 2,
      km_terakhir: 0,
      km_servis_terakhir: 0,
      interval_km_servis: 5000,
      tanggal_servis_terakhir: "",
      tanggal_servis_berikutnya: "",
      catatan_servis: "",
      stnk_tahunan: "",
      stnk_lima_tahunan: "",
      kir_berlaku_sampai: "",
      asuransi_berlaku_sampai: "",
      catatan_dokumen: "",
      status_aktif: "aktif"
    }
  ],

  defaultNoOrderReasons: [
    {
      kode_alasan: "BELUM_MAU_ORDER",
      label_alasan: "Toko belum mau order",
      dihitung_kunjungan_valid: true,
      status_aktif: "aktif"
    },
    {
      kode_alasan: "STOK_ADA_BELANJA_GROSIR_SO",
      label_alasan: "Stok masih ada / belanja ke Grosir atau Star Outlet",
      dihitung_kunjungan_valid: true,
      status_aktif: "aktif"
    },
    {
      kode_alasan: "STOK_MASIH_CUKUP",
      label_alasan: "Stok di toko masih cukup",
      dihitung_kunjungan_valid: true,
      status_aktif: "aktif"
    },
    {
      kode_alasan: "DANA_KURANG_PIUTANG",
      label_alasan: "Dana kurang / masih ada piutang belum tertagih",
      dihitung_kunjungan_valid: true,
      status_aktif: "aktif"
    },
    {
      kode_alasan: "PEMILIK_TIDAK_ADA",
      label_alasan: "Pemilik / penanggung jawab tidak ada di tempat",
      dihitung_kunjungan_valid: true,
      status_aktif: "aktif"
    },
    {
      kode_alasan: "TOKO_TUTUP",
      label_alasan: "Toko tutup",
      dihitung_kunjungan_valid: false,
      status_aktif: "aktif"
    }
  ],

  defaultExpenseCategories: [
    { kode_biaya: "BBM", nama_biaya: "BBM Kendaraan", status_aktif: "aktif" },
    { kode_biaya: "PARKIR", nama_biaya: "Parkir", status_aktif: "aktif" },
    { kode_biaya: "MAKAN", nama_biaya: "Makan / Uang Harian", status_aktif: "aktif" },
    { kode_biaya: "TOL_RETRIBUSI", nama_biaya: "Tol / Retribusi / Bongkar Muat", status_aktif: "aktif" },
    { kode_biaya: "LAINNYA", nama_biaya: "Biaya Operasional Lainnya", status_aktif: "aktif" }
  ],

  /**
   * Mengisi data awal secara aman (idempoten): hanya menambah record
   * yang belum ada berdasarkan kode uniknya.
   */
  async seedDefaults() {
    await db.transaction(
      "rw",
      db.users,
      db.vehicles,
      db.no_order_reasons,
      db.expense_categories,
      async () => {
        for (const u of this.defaultUsers) {
          const exists = await db.users.where("kode_user").equals(u.kode_user).first();
          if (!exists) await db.users.add(u);
        }

        for (const v of this.defaultVehicles) {
          const exists = await db.vehicles.where("kode_kendaraan").equals(v.kode_kendaraan).first();
          if (!exists) await db.vehicles.add(v);
        }

        for (const r of this.defaultNoOrderReasons) {
          const exists = await db.no_order_reasons.where("kode_alasan").equals(r.kode_alasan).first();
          if (!exists) await db.no_order_reasons.add(r);
        }

        for (const c of this.defaultExpenseCategories) {
          const exists = await db.expense_categories.where("kode_biaya").equals(c.kode_biaya).first();
          if (!exists) await db.expense_categories.add(c);
        }
      }
    );
  }
};

// Otomatis jalankan seed saat database pertama kali dibuat
db.on("populate", async () => {
  await SeedHelper.seedDefaults();
});

window.db = db;
window.UnitConverter = UnitConverter;
window.PricingHelper = PricingHelper;
window.SeedHelper = SeedHelper;
