// js/admin-app.js
// Bergantung pada js/db.js, js/master.js, dan SheetJS (XLSX)

const AdminApp = {
  /**
   * Mengambil seluruh shift DJO dengan filter opsional (tanggal, kode_djo, sales_id)
   */
  async getFilteredShifts({ tanggal = "", kode_djo = "", sales_id = "" } = {}) {
    let shifts = await db.djo_shifts.orderBy("id").reverse().toArray();
    if (tanggal) {
      shifts = shifts.filter((s) => s.tanggal === tanggal);
    }
    if (kode_djo) {
      const q = kode_djo.trim().toUpperCase();
      shifts = shifts.filter((s) => String(s.kode_djo || "").toUpperCase().includes(q));
    }
    if (sales_id) {
      shifts = shifts.filter((s) => Number(s.sales_id) === Number(sales_id));
    }
    return shifts;
  },

  /**
   * Menyusun analisis lengkap untuk satu Shift DJO
   */
  async getShiftAudit(shiftId) {
    const idNum = Number(shiftId);
    const shift = await db.djo_shifts.get(idNum);
    if (!shift) return null;

    const sales = shift.sales_id ? await db.users.get(Number(shift.sales_id)) : null;
    const vehicle = shift.vehicle_id ? await db.vehicles.get(Number(shift.vehicle_id)) : null;

    const visits = await db.visits.where("shift_id").equals(idNum).toArray();
    const txs = await db.transactions.where("shift_id").equals(idNum).toArray();
    const returns = await db.returns.where("shift_id").equals(idNum).toArray();

    // Baca debt_payments secara aman tanpa bergantung pada index shift_id
    const allDebtPayments = await db.debt_payments.toArray();
    const debtPayments = allDebtPayments.filter((p) => Number(p.shift_id) === idNum);

    const expenses = await db.expenses.where("shift_id").equals(idNum).toArray();
    const movements = await db.vehicle_stock_movements.where("shift_id").equals(idNum).toArray();
    const products = await db.products.toArray();
    const outlets = await db.outlets.toArray();

    // Hitung KPI EC & Pindah Jadwal
    const ecVisits = visits.filter((v) => v.status_kunjungan === "effective_call");
    const validVisits = visits.filter(
      (v) =>
        v.status_kunjungan === "effective_call" ||
        (v.status_kunjungan === "no_order" && v.dihitung_kunjungan_valid !== false)
    );
    const rescheduledVisits = visits.filter(
      (v) => Number(v.is_rescheduled) === 1 || v.status_kunjungan === "pindah_jadwal"
    );
    const strikeRate = validVisits.length > 0 ? (ecVisits.length / validVisits.length) * 100 : 0;

    // Keuangan & Cost Ratio
    const omzetCash = txs
      .filter((t) => t.metode_bayar === "cash")
      .reduce((a, b) => a + Number(b.total_tagihan || 0), 0);
    const omzetTransfer = txs
      .filter((t) => t.metode_bayar === "transfer")
      .reduce((a, b) => a + Number(b.total_tagihan || 0), 0);
    const omzetKredit = txs
      .filter((t) => t.metode_bayar === "kredit")
      .reduce((a, b) => a + Number(b.total_tagihan || 0), 0);
    const totalOmzet = omzetCash + omzetTransfer + omzetKredit;

    const pelunasanCash = debtPayments
      .filter((p) => p.metode_terima === "cash")
      .reduce((a, b) => a + Number(b.nominal || 0), 0);
    const pelunasanTransfer = debtPayments
      .filter((p) => p.metode_terima === "transfer")
      .reduce((a, b) => a + Number(b.nominal || 0), 0);

    const returBayarTokoCash = returns
      .filter((r) => r.tipe_selisih === "bayar_toko" && r.metode_selisih === "cash")
      .reduce((a, b) => a + Number(b.selisih_nominal || 0), 0);
    const returBayarTokoTransfer = returns
      .filter((r) => r.tipe_selisih === "bayar_toko" && r.metode_selisih === "transfer")
      .reduce((a, b) => a + Number(b.selisih_nominal || 0), 0);
    const returGantiSales = returns
      .filter((r) => r.tipe_selisih === "ganti_sales")
      .reduce((a, b) => a + Number(b.selisih_nominal || 0), 0);

    const totalBiayaCash = expenses
      .filter((e) => e.metode_bayar === "cash")
      .reduce((a, b) => a + Number(b.nominal || 0), 0);
    const totalBiayaAll = expenses.reduce((a, b) => a + Number(b.nominal || 0), 0);
    const costRatio = totalOmzet > 0 ? (totalBiayaAll / totalOmzet) * 100 : 0;

    const wajibSetorTunai =
      omzetCash + pelunasanCash + returBayarTokoCash - totalBiayaCash - returGantiSales;
    const totalTransfer = omzetTransfer + pelunasanTransfer + returBayarTokoTransfer;

    // Audit Stok per Produk
    const stockAudit = products
      .map((prod) => {
        const pMoves = movements.filter((m) => Number(m.product_id) === Number(prod.id));
        let loadingAwal = 0;
        let returMasuk = 0;
        let terjual = 0;
        let keluarGanti = 0;

        for (const m of pMoves) {
          const q = Number(m.qty_bungkus || 0);
          if (m.jenis_mutasi === "loading_awal") loadingAwal += q;
          else if (m.jenis_mutasi === "retur_masuk_jual") returMasuk += q;
          else if (m.jenis_mutasi === "penjualan") terjual += Math.abs(q);
          else if (m.jenis_mutasi === "retur_keluar_ganti") keluarGanti += Math.abs(q);
        }

        const sisaBungkus = loadingAwal + returMasuk - terjual - keluarGanti;
        return {
          sku_kode: prod.sku_kode,
          nama_produk: prod.nama_produk,
          loadingAwal,
          returMasuk,
          terjual,
          keluarGanti,
          sisaBungkus,
          sisaLabel: window.UnitConverter
            ? UnitConverter.formatLabel(sisaBungkus, prod)
            : `${sisaBungkus} bungkus`
        };
      })
      .filter((s) => s.loadingAwal > 0 || s.returMasuk > 0 || s.terjual > 0 || s.keluarGanti > 0);

    // Rincian Kunjungan & Transaksi per Toko (untuk Call Sheet)
    const callSheetRows = visits.map((v, idx) => {
      const outlet = outlets.find((o) => Number(o.id) === Number(v.outlet_id));
      const tx = txs.find((t) => Number(t.visit_id) === Number(v.id));
      const statusPindah =
        Number(v.is_rescheduled) === 1 || v.status_kunjungan === "pindah_jadwal"
          ? `PINDAH JADWAL (${v.djo_asal || "-"} -> ${v.djo_tujuan || "-"})`
          : "Sesuai Jadwal";

      return {
        no: idx + 1,
        waktu: v.waktu_kunjungan ? String(v.waktu_kunjungan).slice(11, 16) : "-",
        kode_toko: outlet?.kode_toko || "-",
        nama_toko: outlet?.nama_toko || "-",
        tier: outlet?.tier_harga || "-",
        status_kunjungan: v.status_kunjungan,
        status_jadwal: statusPindah,
        alasan_non_order: v.reason_label || "-",
        no_nota: tx?.no_nota || "-",
        metode_bayar: tx?.metode_bayar || "-",
        total_tagihan: Number(tx?.total_tagihan || 0),
        catatan: v.catatan || "-"
      };
    });

    const jarakKm =
      shift.km_akhir !== null && shift.km_akhir !== undefined
        ? Number(shift.km_akhir) - Number(shift.km_awal || 0)
        : null;

    return {
      shift,
      salesName: sales?.nama || `Sales #${shift.sales_id}`,
      vehicleLabel: vehicle
        ? `${vehicle.plat_nomor} (${vehicle.nama_kendaraan || vehicle.kode_kendaraan})`
        : "-",
      jarakKm,
      kpi: {
        totalKunjungan: visits.length,
        validVisits: validVisits.length,
        ecCount: ecVisits.length,
        strikeRate,
        rescheduledCount: rescheduledVisits.length,
        shiftRescheduleLogs: shift.riwayat_pindah_jadwal || []
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
        costRatio,
        wajibSetorTunai,
        totalTransfer
      },
      stockAudit,
      callSheetRows,
      returns,
      expenses
    };
  },

  /**
   * Mengambil ringkasan piutang aktif seluruh toko
   */
  async getActiveDebtsSummary() {
    const outlets = await db.outlets.toArray();
    const withDebt = outlets.filter((o) => Number(o.sisa_piutang_aktif || 0) > 0);
    const totalPiutang = withDebt.reduce((a, b) => a + Number(b.sisa_piutang_aktif || 0), 0);
    return { outletsWithDebt: withDebt, totalPiutang };
  },

  /**
   * Ekspor Laporan DJO ke file Excel (.xlsx) menggunakan SheetJS
   */
  async exportShiftToExcel(shiftId) {
    if (typeof XLSX === "undefined") {
      throw new Error("Library SheetJS (XLSX) belum dimuat.");
    }
    const audit = await this.getShiftAudit(shiftId);
    if (!audit) throw new Error("Data shift tidak ditemukan.");

    const wb = XLSX.utils.book_new();

    // Sheet 1: Ringkasan DJO, EC, Keuangan & Pindah Jadwal
    const summaryRows = [
      ["LAPORAN OPERASIONAL DJO — SIMPATIK SFA"],
      ["Kode DJO Aktif", audit.shift.kode_djo],
      ["Kode DJO Awal", audit.shift.djo_awal || audit.shift.kode_djo],
      ["Tanggal", audit.shift.tanggal],
      ["Salesman", audit.salesName],
      ["Asisten Pendamping", audit.shift.asisten_nama || "-"],
      ["Kendaraan", audit.vehicleLabel],
      [
        "KM Awal / Akhir / Tempuh",
        `${audit.shift.km_awal ?? 0} / ${audit.shift.km_akhir ?? "-"} / ${audit.jarakKm ?? "-"} km`
      ],
      ["Status Shift", audit.shift.status_shift],
      [],
      ["INDIKATOR KINERJA (EC & JADWAL)"],
      ["Total Kunjungan Tercatat", audit.kpi.totalKunjungan],
      ["Kunjungan Valid", audit.kpi.validVisits],
      ["Effective Call (EC)", audit.kpi.ecCount],
      ["Strike Rate (%)", `${audit.kpi.strikeRate.toFixed(1)}%`],
      ["Kunjungan Pindah Jadwal", audit.kpi.rescheduledCount],
      ["Perpindahan DJO dalam Shift", audit.kpi.shiftRescheduleLogs.length],
      [],
      ["RINGKASAN KEUANGAN & SETORAN"],
      ["Omzet Cash", audit.keuangan.omzetCash],
      ["Omzet Transfer", audit.keuangan.omzetTransfer],
      ["Omzet Kredit (Piutang Baru)", audit.keuangan.omzetKredit],
      ["Total Omzet Kotor", audit.keuangan.totalOmzet],
      ["Pelunasan Kredit (Cash)", audit.keuangan.pelunasanCash],
      ["Pelunasan Kredit (Transfer)", audit.keuangan.pelunasanTransfer],
      ["Selisih Retur Dibayar Toko (Cash)", audit.keuangan.returBayarTokoCash],
      ["Selisih Retur Dibayar Toko (Transfer)", audit.keuangan.returBayarTokoTransfer],
      ["Selisih Retur Diganti Sales", audit.keuangan.returGantiSales],
      ["Total Biaya Operasional", audit.keuangan.totalBiayaAll],
      ["Cost Ratio (%)", `${audit.keuangan.costRatio.toFixed(2)}%`],
      ["Wajib Setor Tunai (Cash)", audit.keuangan.wajibSetorTunai],
      ["Total Terverifikasi Transfer", audit.keuangan.totalTransfer]
    ];
    const wsSummary = XLSX.utils.aoa_to_sheet(summaryRows);
    XLSX.utils.book_append_sheet(wb, wsSummary, "Ringkasan_DJO");

    // Sheet 2: Call Sheet Kunjungan & Transaksi
    const wsCallSheet = XLSX.utils.json_to_sheet(
      audit.callSheetRows.length
        ? audit.callSheetRows
        : [{ info: "Belum ada catatan kunjungan pada shift ini" }]
    );
    XLSX.utils.book_append_sheet(wb, wsCallSheet, "Call_Sheet_Kunjungan");

    // Sheet 3: Audit Stok Kendaraan
    const stockRows = audit.stockAudit.map((s) => ({
      SKU: s.sku_kode,
      Produk: s.nama_produk,
      Loading_Awal_Bks: s.loadingAwal,
      Retur_Masuk_Jual_Bks: s.returMasuk,
      Terjual_Bks: s.terjual,
      Keluar_Pengganti_Retur_Bks: s.keluarGanti,
      Sisa_Stok_Bks: s.sisaBungkus,
      Sisa_Format_Satuan: s.sisaLabel
    }));
    const wsStock = XLSX.utils.json_to_sheet(
      stockRows.length ? stockRows : [{ info: "Belum ada mutasi stok pada shift ini" }]
    );
    XLSX.utils.book_append_sheet(wb, wsStock, "Audit_Stok_Mobil");

    // Sheet 4: Log Pindah Jadwal & Retur
    const logRows = [
      ...audit.kpi.shiftRescheduleLogs.map((l) => ({
        Jenis: "Pindah DJO Shift",
        Waktu: l.waktu,
        Dari: l.dari_djo,
        Ke: l.ke_djo,
        Keterangan: l.alasan
      })),
      ...audit.returns.map((r) => ({
        Jenis: `Retur (${r.tipe_selisih})`,
        Waktu: r.tanggal,
        Dari: `${r.item_retur?.nama_produk || "-"} (${r.item_retur?.label_qty || "-"})`,
        Ke: `${r.item_pengganti?.nama_produk || "-"} (${r.item_pengganti?.label_qty || "-"})`,
        Keterangan: `Selisih Rp ${Number(r.selisih_nominal || 0).toLocaleString("id-ID")} (${r.metode_selisih})`
      }))
    ];
    const wsLogs = XLSX.utils.json_to_sheet(
      logRows.length ? logRows : [{ info: "Tidak ada log pindah jadwal maupun retur" }]
    );
    XLSX.utils.book_append_sheet(wb, wsLogs, "Log_Jadwal_Retur");

    const fileName = `Laporan_${audit.shift.kode_djo}_${audit.shift.tanggal}.xlsx`;
    XLSX.writeFile(wb, fileName);
    return fileName;
  }
};

window.AdminApp = AdminApp;
