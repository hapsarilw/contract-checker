import { DISCLAIMER_LOCKED } from "../disclaimer.js";

/**
 * BUILD-PLAN step 30 — the Indonesian half of the prototype's `L.id` map
 * (docs/design/ClauseCheck.html), ported string-for-string per BUILD-PLAN
 * decision D-B ("the Indonesian copy is real work and should not be
 * thrown away"). Kept in the repository but NOT wired to anything —
 * locale.js's ACTIVE_LOCALE is "en" — per decision D-B option B1.
 *
 * See strings/en.js for what's deliberately not here (GLOSS, JURIS) and
 * disclaimer.js for why `disclaimer` is a re-export rather than inline
 * text: being unwired does not make this translation of a legally
 * load-bearing string pre-approved to ship later without its own review.
 */
export const id = {
  navNew: "Kontrak baru",
  navHistory: "Riwayat",
  navSignOut: "Keluar",
  back: "Kembali ke riwayat",
  overallRisk: "Risiko keseluruhan",
  shape: "Gambaran singkat",
  where: "Kategori yang bermasalah",
  filterAll: "Semua",
  severity: { HIGH: "Tinggi", MEDIUM: "Sedang", LOW: "Rendah" },
  categories: {
    PAYMENT: "Pembayaran",
    IP: "Hak kekayaan intelektual",
    SCOPE: "Lingkup dan revisi",
    TERMINATION: "Pengakhiran",
    LIABILITY: "Tanggung jawab",
    CONFIDENTIALITY: "Kerahasiaan",
    DISPUTE: "Penyelesaian sengketa",
    OTHER: "Lain-lain",
  },
  findingsHead: "Klausul yang layak dibaca ulang",
  orderNote: "Dari yang paling berat",
  quotedFrom: "Dikutip dari kontrak Anda",
  why: "Mengapa ini penting",
  ask: "Yang perlu Anda minta",
  copyLabel: "Salin permintaan ini",
  copiedLabel: "Tersalin",
  copiedNote: "Tersalin — tempelkan ke balasan Anda untuk klien.",
  missingHead: "Perlindungan yang tidak ada dalam kontrak",
  missingSub:
    "Ini istilah yang umum ada dalam perjanjian kerja lepas. Tidak ada kutipan di bagian ini karena memang tidak ada yang bisa dikutip — itulah intinya. Bagian ini tidak mengubah tingkat risiko di atas, dan biasanya paling mudah diminta selagi kontrak belum ditandatangani.",
  jurisHead: "Catatan untuk yurisdiksi Anda",
  disclaimer: DISCLAIMER_LOCKED.id,
  doneHead: "Selesai dengan kontrak ini?",
  doneBody:
    "Menghapus akan menghilangkan dokumen dan laporan ini sepenuhnya dari basis data kami.",
  deleteCta: "Hapus permanen",
  delKeep: "Simpan dulu",
  delHead: "Hapus kontrak ini secara permanen?",
  delBody:
    "Dokumen dan laporan ini akan dihapus dari basis data kami. Tindakan ini tidak bisa dibatalkan, dan kami tidak akan bisa memulihkannya untuk Anda.",
  findingWord: ["temuan", "temuan"],
  noneFlagged: "Tidak ada klausul yang ditandai",
  showingAll: "menampilkan semua ",
  showing: "menampilkan ",
  of: " dari ",
  sevSuffix: " risiko",
  quoteNote:
    "Kutipan klausul tetap dalam bahasa asli dokumen — menerjemahkannya akan menghilangkan bukti bahwa kalimat itu benar-benar ada di kontrak Anda.",
};
