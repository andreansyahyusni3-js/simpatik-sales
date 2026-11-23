// js/sales-app.js
// Bergantung pada js/db.js (db, UnitConverter, PricingHelper) dan js/auth.js

const SalesApp = {
  /**
   * Mengambil shift DJO yang sedang aktif (status_shift === "aktif") milik sales
   */
  async getActiveShift(salesId) {
    const shifts = await db.djo_shifts
      .where("sales_id")
      .equals(Number(salesId))
      .toArray();
    return shifts.find((s) => s.status_shift === "aktif") || null;
  },

  /**
   * Membuka shift DJO baru (Pilih Asisten, Mobil, DJO, dan KM Awal)
   */
  async openShift({ sales_id, asisten_nama, vehicle_id, kode_djo, tanggal, km_awal }) {
    const existing = await this.getActiveShift(sales_id);
    if (existing) {
      throw new Error(`Masih ada shift DJO aktif (${existing.kode_djo}). Tutup shift tersebut terlebih dahulu.`);
    }

    const cleanAsisten = String(asisten_nama || "").trim();
    const cleanDjo = String(kode_djo || "").trim().toUpperCase();
    const vehId = Number(vehicle_id);

    if (!cleanAsisten) throw new Error("Nama asisten wajib diisi/dipilih.");
    if (!vehId) throw new Error("Mobil/kendaraan wajib dipilih.");
    if (!cleanDjo) throw new Error("Kode DJO wajib dipilih.");

    const vehicle = await db.vehicles.get(vehId);
    if (!vehicle) throw new Error("Data kendaraan tidak ditemukan.");

    const kmStart = Number(km_awal ?? vehicle.km_terakhir ?? 0);
    const tgl = tanggal || new Date().toISOString().slice(0, 10);

    const shiftPayload = {
      kode_djo: cleanDjo,
      djo_awal: cleanDjo,
      tanggal: tgl,
      sales_id: Number(sales_id),
      asisten_nama: cleanAsisten,
      vehicle_id: vehId,
      km_awal: kmStart,
      km_akhir: null,
      status_shift: "aktif",
      riwayat_pindah_jadwal: [],
      opened_at: new Date().toISOString(),
      closed_at: null,
      synced: 0
    };

    const shiftId = await db.djo_shifts.add(shiftPayload);
    return await db.djo_shifts.get(shiftId);
  },

  /**
   * Opsi Pindah Jadwal DJO saat shift sedang berjalan (tercatat di laporan)
   */
  async pindahJadwalShift(shiftId, { djo_tujuan, alasan_pindah }) {
    const shift = await db.djo_shifts.get(Number(shiftId));
    if (!shift) throw new Error("Shift tidak ditemukan.");

    const targetDjo = String(djo_tujuan || "").trim().toUpperCase();
    if (!targetDjo) throw new Error("DJO tujuan wajib diisi.");

    const logItem = {
      waktu: new Date().toISOString(),
      dari_djo: shift.kode_djo,
      ke_djo: targetDjo,
      alasan: String(alasan_pindah || "Penyesuaian rute lapangan").trim()
    };

    const riwayat = Array.isArray(shift.riwayat_pindah_jadwal)
      ? [...shift.riwayat_pindah_jadwal, logItem]
      : [logItem];

    await db.djo_shifts.update(Number(shiftId), {
      kode_djo: targetDjo,
      riwayat_pindah_jadwal: riwayat,
      synced: 0
    });

    return await db.djo_shifts.get(Number(shiftId));
  },

  /**
   * Opsi Pindah Jadwal kunjungan toko tertentu ke DJO/hari lain (tercatat di laporan)
   */
  async pindahJadwalToko({ shift_id, outlet_id, sales_id, tanggal, djo_asal, djo_tujuan, tanggal_tujuan, alasan_pindah }) {
    const outlet = await db.outlets.get(Number(outlet_id));
    if (!outlet) throw new Error("Toko tidak ditemukan.");

    return await db.visits.add({
      shift_id: Number(shift_id),
      tanggal: tanggal || new Date().toISOString().slice(0, 10),
      kode_djo: String(djo_asal || outlet.kode_djo || "").toUpperCase(),
      outlet_id: Number(outlet_id),
      sales_id: Number(sales_id),
      status_kunjungan: "pindah_jadwal",
      reason_id: null,
      is_rescheduled: 1,
      djo_asal: String(djo_asal || outlet.kode_djo || "").toUpperCase(),
      djo_tujuan: String(djo_tujuan || "").toUpperCase(),
      tanggal_tujuan: tanggal_tujuan || "",
      catatan: String(alasan_pindah || "Pindah jadwal kunjungan").trim(),
      waktu_kunjungan: new Date().toISOString(),
      synced: 0
    });
  },

  /**
   * Input Loading Stok Awal Kendaraan (dalam satuan gabungan -> dikonversi ke bungkus)
   */
  async addLoadingStock({ shift_id, vehicle_id, tanggal, product_id, qtyObj }) {
    const product = await db.products.get(Number(product_id));
    if (!product) throw new Error("Produk tidak ditemukan.");

    const qtyBungkus = UnitConverter.toBungkus(qtyObj, product);
    if (qtyBungkus <= 0) throw new Error("Jumlah loading harus lebih dari 0.");

    return await db.vehicle_stock_movements.add({
      shift_id: Number(shift_id),
      tanggal: tanggal || new Date().toISOString().slice(0, 10),
      vehicle_id: Number(vehicle_id),
      product_id: Number(product_id),
      jenis_mutasi: "loading_awal",
      qty_bungkus: qtyBungkus,
      keterangan: `Loading awal (${UnitConverter.formatLabel(qtyBungkus, product)})`,
      created_at: new Date().toISOString(),
      synced: 0
    });
  },

  /**
   * Menghitung stok tersedia saat ini per produk pada shift aktif
   */
  async getShiftStockSummary(shiftId) {
    const products = await db.products.where("status_aktif").equals("aktif").toArray();
    const movements = await db.vehicle_stock_movements
      .where("shift_id")
      .equals(Number(shiftId))
      .toArray();

    return products.map((prod) => {
      const prodMoves = movements.filter((m) => Number(m.product_id) === Number(prod.id));
      let loadingAwal = 0;
      let returMasuk = 0;
      let terjual = 0;
      let keluarPenggantiRetur = 0;

      for (const m of prodMoves) {
        const q = Number(m.qty_bungkus || 0);
        if (m.jenis_mutasi === "loading_awal") loadingAwal += q;
        else if (m.jenis_mutasi === "retur_masuk_jual") returMasuk += q;
        else if (m.jenis_mutasi === "penjualan") terjual += Math.abs(q);
        else if (m.jenis_mutasi === "retur_keluar_ganti") keluarPenggantiRetur += Math.abs(q);
      }

      const sisaBungkus = loadingAwal + returMasuk - terjual - keluarPenggantiRetur;

      return {
        product: prod,
        loadingAwal,
        returMasuk,
        terjual,
        keluarPenggantiRetur,
        sisaBungkus,
        sisaLabel: UnitConverter.formatLabel(sisaBungkus, prod)
      };
    });
  },

  /**
   * Mencatat transaksi penjualan toko (Cash, Transfer, atau Kredit Piutang Penuh)
   */
  async recordSale({ shift_id, outlet_id, sales_id, vehicle_id, kode_djo, tanggal, metode_bayar, items, catatan }) {
    const outlet = await db.outlets.get(Number(outlet_id));
    if (!outlet) throw new Error("Toko tidak ditemukan.");
    if (!Array.isArray(items) || items.length === 0) {
      throw new Error("Minimal harus ada 1 item produk pada transaksi.");
    }

    const stockSummary = await this.getShiftStockSummary(shift_id);
    const preparedItems = [];
    let totalTagihan = 0;

    for (const raw of items) {
      const prod = await db.products.get(Number(raw.product_id));
      if (!prod) throw new Error("Produk tidak ditemukan.");
      const qtyBungkus = UnitConverter.toBungkus(raw.qtyObj, prod);
      if (qtyBungkus <= 0) continue;

      const stokItem = stockSummary.find((s) => Number(s.product.id) === Number(prod.id));
      const sisaTersedia = stokItem ? stokItem.sisaBungkus : 0;
      if (qtyBungkus > sisaTersedia) {
        throw new Error(`Stok ${prod.nama_produk} tidak cukup (tersisa ${UnitConverter.formatLabel(sisaTersedia, prod)}).`);
      }

      const hargaPerBungkus = PricingHelper.getHargaPerBungkus(prod, outlet.tier_harga);
      const subtotal = qtyBungkus * hargaPerBungkus;
      totalTagihan += subtotal;

      preparedItems.push({
        product_id: prod.id,
        sku_kode: prod.sku_kode,
        nama_produk: prod.nama_produk,
        qty_detail: UnitConverter.fromBungkus(qtyBungkus, prod),
        qty_bungkus: qtyBungkus,
        harga_per_bungkus: hargaPerBungkus,
        subtotal
      });
    }

    if (preparedItems.length === 0) {
      throw new Error("Jumlah item penjualan tidak valid.");
    }

    const metode = ["cash", "transfer", "kredit"].includes(metode_bayar) ? metode_bayar : "cash";
    if (metode === "kredit" && !outlet.izinkan_kredit) {
      throw new Error(`Toko ${outlet.nama_toko} tidak diizinkan transaksi kredit.`);
    }

    const tgl = tanggal || new Date().toISOString().slice(0, 10);
    const noNota = `INV-${Date.now()}`;
    const isRescheduled = outlet.kode_djo && kode_djo && outlet.kode_djo !== kode_djo ? 1 : 0;

    return await db.transaction(
      "rw",
      db.visits,
      db.transactions,
      db.vehicle_stock_movements,
      db.outlets,
      async () => {
        const visitId = await db.visits.add({
          shift_id: Number(shift_id),
          tanggal: tgl,
          kode_djo: String(kode_djo || "").toUpperCase(),
          outlet_id: Number(outlet_id),
          sales_id: Number(sales_id),
          status_kunjungan: "effective_call",
          reason_id: null,
          is_rescheduled: isRescheduled,
          djo_asal: outlet.kode_djo || "",
          djo_tujuan: String(kode_djo || "").toUpperCase(),
          catatan: String(catatan || "").trim(),
          waktu_kunjungan: new Date().toISOString(),
          synced: 0
        });

        const txId = await db.transactions.add({
          no_nota: noNota,
          shift_id: Number(shift_id),
          visit_id: visitId,
          tanggal: tgl,
          outlet_id: Number(outlet_id),
          nama_toko: outlet.nama_toko,
          tier_harga: outlet.tier_harga,
          sales_id: Number(sales_id),
          items: preparedItems,
          total_tagihan: totalTagihan,
          metode_bayar: metode,
          status_bayar: metode === "kredit" ? "belum_lunas" : "lunas",
          sisa_piutang: metode === "kredit" ? totalTagihan : 0,
          catatan: String(catatan || "").trim(),
          created_at: new Date().toISOString(),
          synced: 0
        });

        for (const item of preparedItems) {
          await db.vehicle_stock_movements.add({
            shift_id: Number(shift_id),
            tanggal: tgl,
            vehicle_id: Number(vehicle_id),
            product_id: Number(item.product_id),
            jenis_mutasi: "penjualan",
            qty_bungkus: -item.qty_bungkus,
            keterangan: `Penjualan ${noNota} (${outlet.nama_toko})`,
            created_at: new Date().toISOString(),
            synced: 0
          });
        }

        if (metode === "kredit") {
          const piutangBaru = Number(outlet.sisa_piutang_aktif || 0) + totalTagihan;
          await db.outlets.update(Number(outlet_id), { sisa_piutang_aktif: piutangBaru });
        }

        return txId;
      }
    );
  },

  /**
   * Mencatat Retur Tukar Barang (sejenis atau beda produk) + selisih harga + stok langsung dijual
   */
  async recordReturnExchange({
    shift_id,
    outlet_id,
    sales_id,
    vehicle_id,
    kode_djo,
    tanggal,
    returItem,
    gantiItem,
    kondisi_retur = "bagus",
    metode_selisih = "cash",
    catatan = ""
  }) {
    const outlet = await db.outlets.get(Number(outlet_id));
    if (!outlet) throw new Error("Toko tidak ditemukan.");

    const prodRetur = await db.products.get(Number(returItem.product_id));
    const prodGanti = await db.products.get(Number(gantiItem.product_id));
    if (!prodRetur || !prodGanti) throw new Error("Produk retur atau produk pengganti wajib dipilih.");

    const qtyReturBks = UnitConverter.toBungkus(returItem.qtyObj, prodRetur);
    const qtyGantiBks = UnitConverter.toBungkus(gantiItem.qtyObj, prodGanti);
    if (qtyReturBks <= 0 || qtyGantiBks <= 0) {
      throw new Error("Jumlah barang retur dan barang pengganti harus lebih dari 0.");
    }

    // Cek ketersediaan stok barang pengganti di kendaraan
    const stockSummary = await this.getShiftStockSummary(shift_id);
    const stokGanti = stockSummary.find((s) => Number(s.product.id) === Number(prodGanti.id));
    const sisaTersedia = stokGanti ? stokGanti.sisaBungkus : 0;
    // Jika produk sama dan kondisi bagus, stok bertambah dulu dari retur
    const efektifTersedia =
      Number(prodRetur.id) === Number(prodGanti.id) && kondisi_retur === "bagus"
        ? sisaTersedia + qtyReturBks
        : sisaTersedia;

    if (qtyGantiBks > efektifTersedia) {
      throw new Error(`Stok barang pengganti (${prodGanti.nama_produk}) tidak mencukupi.`);
    }

    const hargaRetur = PricingHelper.getHargaPerBungkus(prodRetur, outlet.tier_harga);
    const hargaGanti = PricingHelper.getHargaPerBungkus(prodGanti, outlet.tier_harga);
    const nilaiRetur = qtyReturBks * hargaRetur;
    const nilaiGanti = qtyGantiBks * hargaGanti;
    const calc = PricingHelper.hitungSelisihRetur(nilaiRetur, nilaiGanti);

    const tgl = tanggal || new Date().toISOString().slice(0, 10);
    const noRetur = `RTR-${Date.now()}`;

    return await db.transaction(
      "rw",
      db.returns,
      db.vehicle_stock_movements,
      async () => {
        const returId = await db.returns.add({
          no_retur: noRetur,
          shift_id: Number(shift_id),
          visit_id: null,
          tanggal: tgl,
          kode_djo: String(kode_djo || "").toUpperCase(),
          outlet_id: Number(outlet_id),
          nama_toko: outlet.nama_toko,
          sales_id: Number(sales_id),
          kondisi_retur,
          item_retur: {
            product_id: prodRetur.id,
            nama_produk: prodRetur.nama_produk,
            qty_bungkus: qtyReturBks,
            label_qty: UnitConverter.formatLabel(qtyReturBks, prodRetur),
            harga_per_bungkus: hargaRetur,
            nilai: nilaiRetur
          },
          item_pengganti: {
            product_id: prodGanti.id,
            nama_produk: prodGanti.nama_produk,
            qty_bungkus: qtyGantiBks,
            label_qty: UnitConverter.formatLabel(qtyGantiBks, prodGanti),
            harga_per_bungkus: hargaGanti,
            nilai: nilaiGanti
          },
          nilai_retur: calc.nilai_retur,
          nilai_pengganti: calc.nilai_pengganti,
          selisih_nominal: calc.selisih_nominal,
          tipe_selisih: calc.tipe_selisih, // 'bayar_toko' | 'ganti_sales' | 'impas'
          metode_selisih: calc.tipe_selisih === "impas" ? "impas" : metode_selisih,
          catatan: String(catatan || "").trim(),
          created_at: new Date().toISOString(),
          synced: 0
        });

        // Jika kondisi retur bagus -> langsung masuk kembali ke stok jual kendaraan
        if (kondisi_retur === "bagus") {
          await db.vehicle_stock_movements.add({
            shift_id: Number(shift_id),
            tanggal: tgl,
            vehicle_id: Number(vehicle_id),
            product_id: Number(prodRetur.id),
            jenis_mutasi: "retur_masuk_jual",
            qty_bungkus: qtyReturBks,
            keterangan: `Retur masuk layak jual ${noRetur} (${outlet.nama_toko})`,
            created_at: new Date().toISOString(),
            synced: 0
          });
        }

        // Barang pengganti mengurangi stok kendaraan
        await db.vehicle_stock_movements.add({
          shift_id: Number(shift_id),
          tanggal: tgl,
          vehicle_id: Number(vehicle_id),
          product_id: Number(prodGanti.id),
          jenis_mutasi: "retur_keluar_ganti",
          qty_bungkus: -qtyGantiBks,
          keterangan: `Barang pengganti retur ${noRetur} (${outlet.nama_toko})`,
          created_at: new Date().toISOString(),
          synced: 0
        });

        return returId;
      }
    );
  },

  /**
   * Mencatat pelunasan kredit / piutang toko (Cash atau Transfer)
   */
  async recordDebtPayment({ shift_id, outlet_id, sales_id, tanggal, nominal, metode_terima, catatan }) {
    const outlet = await db.outlets.get(Number(outlet_id));
    if (!outlet) throw new Error("Toko tidak ditemukan.");

    const bayar = Number(nominal || 0);
    if (bayar <= 0) throw new Error("Nominal pembayaran kredit harus lebih dari 0.");

    const piutangSaatIni = Number(outlet.sisa_piutang_aktif || 0);
    const sisaBaru = Math.max(0, piutangSaatIni - bayar);

    return await db.transaction("rw", db.debt_payments, db.outlets, async () => {
      const id = await db.debt_payments.add({
        no_bayar: `PAY-${Date.now()}`,
        shift_id: Number(shift_id),
        transaction_id: null,
        outlet_id: Number(outlet_id),
        nama_toko: outlet.nama_toko,
        sales_id: Number(sales_id),
        tanggal: tanggal || new Date().toISOString().slice(0, 10),
        nominal: bayar,
        metode_terima: metode_terima === "transfer" ? "transfer" : "cash",
        catatan: String(catatan || "").trim(),
        created_at: new Date().toISOString(),
        synced: 0
      });

      await db.outlets.update(Number(outlet_id), { sisa_piutang_aktif: sisaBaru });
      return id;
    });
  },

  /**
   * Mencatat kunjungan tanpa transaksi (No Order) untuk perhitungan EC
   */
  async recordNoOrderVisit({ shift_id, outlet_id, sales_id, kode_djo, tanggal, reason_id, catatan }) {
    const outlet = await db.outlets.get(Number(outlet_id));
    const reason = await db.no_order_reasons.get(Number(reason_id));
    if (!outlet || !reason) throw new Error("Toko dan alasan tidak beli wajib dipilih.");

    const isRescheduled = outlet.kode_djo && kode_djo && outlet.kode_djo !== kode_djo ? 1 : 0;

    return await db.visits.add({
      shift_id: Number(shift_id),
      tanggal: tanggal || new Date().toISOString().slice(0, 10),
      kode_djo: String(kode_djo || "").toUpperCase(),
      outlet_id: Number(outlet_id),
      sales_id: Number(sales_id),
      status_kunjungan: "no_order",
      reason_id: Number(reason_id),
      reason_label: reason.label_alasan,
      dihitung_kunjungan_valid: Boolean(reason.dihitung_kunjungan_valid),
      is_rescheduled: isRescheduled,
      djo_asal: outlet.kode_djo || "",
      djo_tujuan: String(kode_djo || "").toUpperCase(),
      catatan: String(catatan || "").trim(),
      waktu_kunjungan: new Date().toISOString(),
      synced: 0
    });
  },

  /**
   * Input biaya operasional harian sales
   */
  async addExpense({ shift_id, sales_id, tanggal, category_id, nominal, metode_bayar = "cash", keterangan }) {
    const cat = await db.expense_categories.get(Number(category_id));
    const amount = Number(nominal || 0);
    if (!cat || amount <= 0) throw new Error("Kategori biaya dan nominal wajib diisi.");

    return await db.expenses.add({
      shift_id: Number(shift_id),
      tanggal: tanggal || new Date().toISOString().slice(0, 10),
      sales_id: Number(sales_id),
      category_id: Number(category_id),
      nama_biaya: cat.nama_biaya,
      nominal: amount,
      metode_bayar,
      keterangan: String(keterangan || "").trim(),
      created_at: new Date().toISOString(),
      synced: 0
    });
  },

  /**
   * Menyusun Laporan Lengkap & Ringkasan Setoran Akhir Hari Sales
   */
  async getShiftReport(shiftId) {
    const shift = await db.djo_shifts.get(Number(shiftId));
    if (!shift) return null;

    const vehicle = await db.vehicles.get(Number(shift.vehicle_id));
    const visits = await db.visits.where("shift_id").equals(Number(shiftId)).toArray();
    const txs = await db.transactions.where("shift_id").equals(Number(shiftId)).toArray();
    const returns = await db.returns.where("shift_id").equals(Number(shiftId)).toArray();
    const debtPayments = await db.debt_payments.where("shift_id").equals(Number(shiftId)).toArray();
    const expenses = await db.expenses.where("shift_id").equals(Number(shiftId)).toArray();
    const stockSummary = await this.getShiftStockSummary(shiftId);

    const ecCount = visits.filter((v) => v.status_kunjungan === "effective_call").length;
    const noOrderCount = visits.filter((v) => v.status_kunjungan === "no_order").length;
    const pindahJadwalCount = visits.filter((v) => Number(v.is_rescheduled) === 1 || v.status_kunjungan === "pindah_jadwal").length;

    const omzetCash = txs.filter((t) => t.metode_bayar === "cash").reduce((a, b) => a + Number(b.total_tagihan || 0), 0);
    const omzetTransfer = txs.filter((t) => t.metode_bayar === "transfer").reduce((a, b) => a + Number(b.total_tagihan || 0), 0);
    const omzetKredit = txs.filter((t) => t.metode_bayar === "kredit").reduce((a, b) => a + Number(b.total_tagihan || 0), 0);
    const totalOmzet = omzetCash + omzetTransfer + omzetKredit;

    const pelunasanCash = debtPayments.filter((p) => p.metode_terima === "cash").reduce((a, b) => a + Number(b.nominal || 0), 0);
    const pelunasanTransfer = debtPayments.filter((p) => p.metode_terima === "transfer").reduce((a, b) => a + Number(b.nominal || 0), 0);

    const returBayarTokoCash = returns
      .filter((r) => r.tipe_selisih === "bayar_toko" && r.metode_selisih === "cash")
      .reduce((a, b) => a + Number(b.selisih_nominal || 0), 0);
    const returBayarTokoTransfer = returns
      .filter((r) => r.tipe_selisih === "bayar_toko" && r.metode_selisih === "transfer")
      .reduce((a, b) => a + Number(b.selisih_nominal || 0), 0);
    const returGantiSales = returns
      .filter((r) => r.tipe_selisih === "ganti_sales")
      .reduce((a, b) => a + Number(b.selisih_nominal || 0), 0);

    const totalBiayaCash = expenses.filter((e) => e.metode_bayar === "cash").reduce((a, b) => a + Number(b.nominal || 0), 0);
    const totalBiayaAll = expenses.reduce((a, b) => a + Number(b.nominal || 0), 0);

    const wajibSetorTunai = omzetCash + pelunasanCash + returBayarTokoCash - totalBiayaCash - returGantiSales;
    const totalTerverifikasiTransfer = omzetTransfer + pelunasanTransfer + returBayarTokoTransfer;

    return {
      shift,
      vehicle,
      visits,
      txs,
      returns,
      debtPayments,
      expenses,
      stockSummary,
      kpi: {
        totalKunjungan: visits.length,
        ecCount,
        noOrderCount,
        pindahJadwalCount
      },
      keuangan: {
        omzetCash,
        omzetTransfer,
        omzetKredit,
        totalOmzet,
        pelunasanCash,
        pelunasanTransfer,
        returBayarTokoCash,
        returBayarTokoTransfer,
        returGantiSales,
        totalBiayaCash,
        totalBiayaAll,
        wajibSetorTunai,
        totalTerverifikasiTransfer
      }
    };
  },

  /**
   * Tutup Shift DJO & simpan KM Akhir ke Master Kendaraan
   */
  async closeShift(shiftId, kmAkhir) {
    const shift = await db.djo_shifts.get(Number(shiftId));
    if (!shift) throw new Error("Shift tidak ditemukan.");

    const endKm = Number(kmAkhir || 0);
    if (endKm < Number(shift.km_awal || 0)) {
      throw new Error(`KM Akhir (${endKm}) tidak boleh lebih kecil dari KM Awal (${shift.km_awal}).`);
    }

    await db.transaction("rw", db.djo_shifts, db.vehicles, async () => {
      await db.djo_shifts.update(Number(shiftId), {
        km_akhir: endKm,
        status_shift: "selesai",
        closed_at: new Date().toISOString(),
        synced: 0
      });

      await db.vehicles.update(Number(shift.vehicle_id), {
        km_terakhir: endKm
      });
    });
  }
};

window.SalesApp = SalesApp;
