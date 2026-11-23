// js/db.js
// Pastikan Dexie.js dimuat sebelum file ini:
// <script src="https://unpkg.com/dexie@3/dist/dexie.js"></script>

const db = new Dexie("SimpatikSFA_DB");

// Versi 1: Master Data + Operasional Lapangan + Retur + Piutang
db.version(1).stores({
  // Master Data
  users: "++id, kode_user, nama, username, role, kode_rute, kendaraan_id, status_aktif",
  products: "++id, sku_kode, nama_produk, kategori_lini, status_aktif",
  outlets: "++id, kode_toko, nama_toko, kode_djo, sales_id, tier_harga, status_toko",
  vehicles: "++id, kode_kendaraan, plat_nomor, sales_id, status_aktif",
  no_order_reasons: "++id, kode_alasan, dihitung_kunjungan_valid, status_aktif",
  expense_categories: "++id, kode_biaya, status_aktif",

  // Operasional Harian & Rute (DJO)
  djo_shifts: "++id, kode_djo, tanggal, sales_id, vehicle_id, status_shift, synced",
  visits: "++id, shift_id, tanggal, kode_djo, outlet_id, sales_id, status_kunjungan, reason_id, synced",
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
   * Bisa menerima faktor custom pada produk jika diperlukan, default 4 / 20 / 10.
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

window.db = db;
window.UnitConverter = UnitConverter;
window.PricingHelper = PricingHelper;
