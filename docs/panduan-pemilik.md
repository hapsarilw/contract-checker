# Panduan pemilik: langkah yang hanya bisa Anda kerjakan

BUILD-PLAN langkah 75. Semua yang bisa dikerjakan dari repositori sudah dikerjakan: kode, konfigurasi, tes, drill lokal. Yang tersisa butuh **akun, uang, tanda tangan, atau manusia**, jadi hanya Anda yang bisa melakukannya. Dokumen ini urutannya. Referensi teknis di balik setiap langkah ada di [staging-setup.md](staging-setup.md); status tiap item DoD ada di [phase-1.5-dod.md](phase-1.5-dod.md).

**Istilah singkat.**

- **DoD** (*Definition of Done*): daftar syarat yang harus terbukti terpenuhi sebelum sebuah fase boleh dianggap selesai. PRD §9 punya tujuh syarat untuk Phase 1.5; tanpa ketujuhnya, produk tidak boleh diluncurkan.
- **Staging**: salinan produksi untuk menguji, dengan data sintetis dan secret-nya sendiri.
- **Secret**: kunci API, password, atau token. Aturannya tetap sama:
  - secret tidak pernah ditempel di chat, di repo, atau di `client/.env`;
  - simpan di *secret store* platform hosting;
  - setiap lingkungan memakai kunci sendiri, tidak pernah berbagi dengan development.

**Urutan besarnya:**

| # | Langkah | Membuka |
|---|---|---|
| A | GitHub: push, CI pertama, branch protection, pelaporan kerentanan | semua deploy |
| B | Anthropic: cabut kunci lama, kunci per lingkungan, keputusan ZDR dan `inference_geo` | staging, produksi |
| C | Domain | email, staging |
| D | Resend (email) | staging bisa boot |
| E | Render (API, database, Redis) | staging |
| F | Netlify (frontend) | staging |
| G | GitHub environments: secret dan variabel | deploy otomatis |
| H | Deploy pertama ke staging, akun smoke | item 4, Phase 1 DoD item 1 |
| I | Grafana Cloud dan PagerDuty | item 5 |
| J | Drill di staging | item 2, 3, 5 |
| K | Legal bersama konsultan hukum | item 6 |
| L | Tester eksternal | item 1, Phase 1 DoD item 2 |
| M | Uji screen reader | item 7 |
| N | Produksi, lalu tahap rollout | peluncuran |

---

## A. GitHub

1. **Push `main`** dari komputer Anda:
   ```bash
   git push origin main
   ```
   Saya tidak pernah melakukan push; ini selalu langkah Anda.
2. **Tunggu CI pertama selesai** (tab *Actions*). Kalau ada job yang gagal, perbaiki dulu sebelum lanjut.
3. **Jalankan scan pertama:** *Actions* → *scan* → *Run workflow*, atau:
   ```bash
   gh workflow run scan.yml
   ```
4. **Aktifkan pelaporan kerentanan privat:** *Settings* → *Security* (*Code security*) → *Private vulnerability reporting* → *Enable*. `SECURITY.md` dan `security.txt` sudah menunjuk ke sini.
5. **Pasang branch protection, sesudah CI pernah berjalan sekali.** Kalau dipasang sebelumnya, GitHub menunggu check yang belum pernah ada, dan `main` terkunci selamanya.
   ```bash
   brew install gh && gh auth login
   scripts/configure-branch-protection.sh --dry-run   # periksa dulu
   scripts/configure-branch-protection.sh
   ```
6. **Visibilitas image.** Image server didorong ke `ghcr.io/hapsarilw/clausecheck-server:<sha>` oleh `deploy.yml`. Pilih salah satu:
   - buka *Packages* → *clausecheck-server* → *Package settings* → *Change visibility* → *Public* (repositori ini sudah publik); atau
   - beri Render kredensial registry: token GitHub dengan izin `read:packages`.

## B. Anthropic

1. **Pastikan kunci development yang lama sudah dicabut.** Di console Anthropic → *API keys*: kunci lama harus berstatus *revoked*/terhapus. Catat tanggalnya di log [runbooks/secret-rotation.md](runbooks/secret-rotation.md).
2. **Buat dua kunci baru:** satu untuk staging, satu untuk produksi.
   - Masing-masing sebaiknya di *workspace* sendiri, dengan **batas belanja** sendiri (misalnya staging USD 10/bulan; produksi sesuai `MONTHLY_SPEND_CEILING_USD`).
   - Kunci tidak dicatat di mana pun selain secret store Render (langkah E).
3. **Zero data retention (ZDR), opsional.** Ini perjanjian dengan Anthropic, bukan pengaturan.
   - Hubungi tim sales/support Anthropic dan tanyakan apakah akun Anda bisa mendapat ZDR untuk Messages API.
   - Jika disetujui, catat tanggal dan ruang lingkupnya di [legal/verification.md](legal/verification.md), lalu ubah kalimat retensi di kebijakan privasi bersama konsultan hukum.
4. **Keputusan `inference_geo`.**
   - Sekarang: tidak diset, artinya default workspace `"global"`. Inferensi boleh berjalan di region mana pun, dan itulah yang tertulis di kebijakan privasi serta daftar subprosesor.
   - `"us"`: inferensi hanya di infrastruktur AS, harga 1,1x (biaya per analisis kira-kira USD 0,0192 → 0,0211). Satu tujuan transfer data lebih mudah dianalisis untuk UU PDP/GDPR.
   - **Saran: putuskan bersama konsultan hukum** (langkah K). Jika memilih `"us"`, ubah tiga hal dalam satu commit:
     - tambahkan `ANTHROPIC_INFERENCE_GEO=us` di `ops/render/production.render.yaml` dan staging;
     - ganti teks di `client/src/legal/content.js`: "Any region where Anthropic operates (its default “global” processing)" menjadi "The United States (inference_geo: us)", dan kalimat "may run in any of the regions..." disesuaikan;
     - tes `renderBlueprints.test.js` sengaja gagal bila konfigurasi dan teks legal tidak cocok.

## C. Domain

Beli satu domain (contoh di bawah: `example.com`). **Frontend dan API harus berada di bawah satu domain yang sama.** Cookie sesi bertipe `SameSite=Lax`, dan dengan domain bawaan `*.netlify.app` + `*.onrender.com` login akan gagal tanpa pesan error yang jelas.

| | Frontend | API |
|---|---|---|
| Staging | `staging.example.com` | `api.staging.example.com` |
| Produksi | `app.example.com` | `api.example.com` |

## D. Resend (email)

1. Daftar di resend.com, lalu *Domains* → *Add domain*: misalnya `mail.example.com`.
2. Pasang record DNS yang diberikan Resend (SPF, DKIM) di penyedia domain, ditambah DMARC (`_dmarc` TXT `v=DMARC1; p=none; rua=mailto:<email Anda>`). Tunggu sampai status *Verified*.
3. *API Keys* → buat **dua kunci dengan izin *Sending access* saja**, satu untuk staging dan satu untuk produksi.
4. Alamat pengirim, misalnya `ClauseCheck <noreply@mail.example.com>`, menjadi `EMAIL_FROM`.

## E. Render (API, Postgres, Key Value, agen metrik)

1. Daftar di render.com dan tambahkan metode pembayaran. Plan yang dipakai berbayar: *starter* untuk API dan Key Value, *basic-1gb* untuk Postgres.
2. Tunggu sampai `deploy.yml` sudah mendorong satu image (job `image` hijau setelah langkah A). Catat SHA commit-nya.
3. Buka `ops/render/staging.render.yaml` dan ganti tag `:bootstrap` dengan SHA itu. Commit dan push.
4. *New* → *Blueprint* → pilih repositori ini → *Blueprint path*: `ops/render/staging.render.yaml`.
   - Render akan meminta nilai untuk variabel `sync: false`. Isi:

     | Variabel | Nilai |
     |---|---|
     | `ANTHROPIC_API_KEY` | kunci staging (B.2) |
     | `EMAIL_PROVIDER_KEY` | kunci Resend staging |
     | `EMAIL_FROM` | alamat pengirim (D.4) |
     | `FRONTEND_ORIGIN` | `https://staging.example.com` |
     | `SENTRY_DSN` | boleh kosong |
     | `REMOTE_WRITE_*` | dari langkah I; boleh diisi belakangan |

   - Kalau Render menolak nama field (misalnya `maxShutdownDelaySeconds`), cocokkan dengan referensi Blueprint Render, perbaiki file, lalu jalankan `npm test` di `server` (tes `renderBlueprints` ikut diperbarui).
5. Di layanan `clausecheck-api-staging`, tambahkan domain kustom `api.staging.example.com` lalu pasang record DNS-nya.
6. Catat **Service ID** (`srv-...`) layanan API. Buat **API key** Render di *Account settings* → *API keys*.
7. Periksa dua hal di dokumentasi Render, karena konfigurasi bergantung padanya:
   - **batas waktu request harus lebih dari 120 detik** (analisis bisa sampai 90 detik);
   - **nama discovery** `clausecheck-api-staging-discovery` harus me-resolve ke semua instance.

## F. Netlify (frontend)

1. Daftar di netlify.com, lalu *Add new site* → *Deploy manually* (tanpa build dari Git; GitHub Actions yang mengirim hasil build).
2. Domain kustom: `staging.example.com`.
3. Catat **Site ID** (*Site configuration* → *Site details*). Buat **Personal access token** (*User settings* → *Applications*).
4. Header keamanan (CSP FR-7.9) dan rute SPA sudah ikut di setiap build (`_headers`, `_redirects`), jadi tidak ada yang perlu diatur di dashboard.

## G. GitHub environments

*Settings* → *Environments* → buat `staging` dan `production`. Beri `production` *required reviewer* (Anda). Untuk masing-masing, **di level environment, bukan repositori**:

| Jenis | Nama | Isi (staging) |
|---|---|---|
| secret | `DATABASE_URL` | *External Database URL* Postgres staging dari Render (untuk job migrasi) |
| secret | `PLATFORM_TOKEN` | API key Render |
| secret | `FRONTEND_PLATFORM_TOKEN` | token Netlify |
| secret | `SMOKE_ACCOUNT_PASSWORD` | password akun smoke (langkah H) |
| variable | `DEPLOY_PLATFORM` | `render` |
| variable | `FRONTEND_PLATFORM` | `netlify` |
| variable | `RENDER_SERVICE_ID` | `srv-...` |
| variable | `NETLIFY_SITE_ID` | Site ID |
| variable | `API_URL` | `https://api.staging.example.com` |
| variable | `FRONTEND_URL` | `https://staging.example.com` |
| variable | `SMOKE_ACCOUNT_EMAIL` | alamat akun smoke |
| variable | `PROMETHEUS_URL`, secret `PROMETHEUS_TOKEN` | opsional (langkah I) |
| variable | `E2E_MAILBOX` | belum ada; lihat catatan TR-24 di [staging-setup.md](staging-setup.md) |

Kunci Anthropic **tidak** pernah masuk GitHub. Dua environment tambahan untuk benchmark (`benchmark`, `benchmark-pr` dengan `ANTHROPIC_BENCHMARK_KEY` milik sendiri) dijelaskan di [deployment.md](deployment.md) §9.

## H. Deploy pertama ke staging

1. Jalankan ulang workflow *deploy* untuk commit terakhir. Urutannya otomatis: image → migrasi → API → frontend → verifikasi.
2. **Akun smoke:** daftar di `https://staging.example.com` dengan alamat yang Anda kuasai, lalu verifikasi lewat email asli. Simpan password-nya sebagai secret `SMOKE_ACCOUNT_PASSWORD`, dan alamatnya sebagai `SMOKE_ACCOUNT_EMAIL`.
3. `verify-staging` harus hijau: smoke, analisis panjang lewat proxy Render, E2E + axe.
   - TR-24 (journey dengan email) masih gagal sampai ada kotak surat yang bisa dibaca tes. Kegagalan ini disengaja dan sudah tercatat.
   - Durasi analisis panjang dicatat di log [deployment.md](deployment.md).
4. Uji rollback: jalankan workflow secara manual dengan SHA sebelumnya, lalu catat hasilnya.

## I. Monitoring dan paging

1. **Grafana Cloud:** buat **dua stack**, `clausecheck-staging` dan `clausecheck-production`. Satu stack per lingkungan, supaya drill di staging tidak membangunkan pager produksi. Dari setiap stack, catat:
   - URL *remote write* Prometheus, *instance ID* (username), dan token dengan izin *metrics:write*. Masukkan ke `REMOTE_WRITE_URL`, `REMOTE_WRITE_USERNAME`, `REMOTE_WRITE_PASSWORD` di layanan `clausecheck-metrics-<lingkungan>` di Render.
   - Token dengan izin *rules:write* dan *alerts:write*, untuk dua perintah di bawah.
2. **Muat aturan alert** (aturan yang sama, untuk setiap stack):
   ```bash
   docker run --rm -v "$PWD/ops/alerts:/a:ro" grafana/mimirtool rules load /a/alerts.yml \
     --address=<URL Prometheus stack> --id=<instance ID> --key=<token>
   ```
3. **PagerDuty:** buat *service* ClauseCheck, lalu *Integrations* → *Events API v2*. Catat *routing key*-nya.
4. **Muat konfigurasi Alertmanager** dengan receiver sungguhan. Hasilnya berisi secret; buat, muat, lalu hapus:
   ```bash
   cd server
   PAGERDUTY_ROUTING_KEY=... DIGEST_EMAIL_TO=<email Anda> DIGEST_SMTP_SMARTHOST=smtp.resend.com:587 \
   DIGEST_SMTP_FROM=alerts@mail.example.com DIGEST_SMTP_USERNAME=resend DIGEST_SMTP_PASSWORD=<kunci Resend> \
     node scripts/render-alertmanager.js --out /tmp/alertmanager.yml
   docker run --rm -v /tmp:/t grafana/mimirtool alertmanager load /t/alertmanager.yml \
     --address=<URL Alertmanager stack> --id=<instance ID Alertmanager> --key=<token>
   rm /tmp/alertmanager.yml
   ```
   Skrip ini menolak menulis apa pun bila ada nilai yang kosong, dan memeriksa bahwa routing dan inhibisi tetap persis milik `ops/alerts/alertmanager.yml`, yaitu yang sudah diuji lewat drill.
5. **Sentry (opsional):** buat project, pilih **region data (US atau EU)**, lalu masukkan DSN ke `SENTRY_DSN`. Region itu harus ditulis di daftar subprosesor (langkah K).

## J. Drill di staging

| Drill | Cara | Catat di |
|---|---|---|
| Alert (item 5) | endpoint drill dengan `ALERT_DRILL_TOKEN` (langkah 68); pastikan page sampai di PagerDuty dan digest di email | [alert-drills.md](alert-drills.md) |
| Gangguan provider (item 3) | kunci Anthropic khusus staging yang diarahkan ke endpoint yang menjawab 529, atau cabut sementara | [phase-1.5-dod.md](phase-1.5-dod.md) §3 |
| Database mati | *failover*/restart Postgres dari dashboard Render | phase-1.5-dod.md |
| Restore (item 2) | point-in-time recovery Render ke database baru; ukur waktunya terhadap RTO 4 jam | [runbooks/database-restore.md](runbooks/database-restore.md) |

**Celah yang perlu diketahui:** `backup-verify` di mode produksi tidak bisa membaca backup Render, sehingga `backup_verify_failed` akan memicu page setiap minggu. Ini benar secara faktual: belum ada yang memverifikasi backup. Perbaikannya (backup harian `pg_dump` ke bucket S3, dan job yang memeriksanya) masih terutang sebagai pekerjaan engineering; lihat [staging-setup.md](staging-setup.md).

## K. Legal (bersama konsultan hukum)

Isi setiap `[PLACEHOLDER]` di `client/src/legal/content.js`. Halaman legal sendiri menampilkan daftar yang masih kosong:

- nama operator;
- alamat kontak dan alamat privasi;
- provider hosting, database, cache, dan email beserta region-nya (dari langkah D sampai F);
- region Sentry;
- hukum yang berlaku;
- klausul tanggung jawab;
- mekanisme transfer lintas negara.

Selain itu, putuskan apakah diperlukan versi bahasa Indonesia. Begitu placeholder habis, banner "Draft: not yet in force" hilang dengan sendirinya. **Konsultan hukum harus meninjau ketiga dokumen sebelum peluncuran** (PRD §17).

## L. Tester eksternal (item 1, dan Phase 1 DoD item 2)

Cari satu orang yang **bukan Anda** dan **belum pernah melihat alurnya**.

1. **Phase 1 DoD item 2:** tester mendaftar, menganalisis satu kontrak nyata, dan membaca laporannya tanpa bertanya apa pun.
2. **Phase 1.5 item 1:** sebelum tester menghapus akunnya, rekam identitas akunnya dari *Shell* layanan API di Render:
   ```bash
   npm run ops -- erasure-record --email <alamat tester> --out /tmp/erasure.json
   ```
   Kemudian, tanpa bantuan: tester memakai *lupa password*, mengatur ulang password, masuk, lalu menghapus akun dari *Settings*.
3. Sesudahnya, di shell yang sama:
   ```bash
   npm run ops -- erasure-verify --in /tmp/erasure.json --email <alamat tester>
   ```
   Hasil yang diharapkan adalah **CLEAN**. Salin keluarannya ke [phase-1.5-dod.md](phase-1.5-dod.md) §1.

## M. Uji screen reader (item 7)

Ikuti skrip di [accessibility-audit.md](accessibility-audit.md) §5: NVDA + Firefox di Windows, atau VoiceOver + Safari di Mac, untuk ketujuh layar inti dan layar `/confirm-email-change` yang baru. Catat setiap temuan; yang bersifat blocking harus diperbaiki sebelum audit bisa ditutup.

## N. Produksi dan tahap rollout

1. **Produksi** = langkah E sampai I dengan `ops/render/production.render.yaml`, domain `app.`/`api.`, dan kunci produksi.
   - `deploy-production` menunggu persetujuan Anda (*required reviewer*).
   - Sesudah deploy ada pemantauan otomatis selama 15 menit.
2. **Internal** (PRD §15): Anda sendiri menjalankan **10 kontrak nyata** dan membaca setiap laporan. Catat id analisis dan laporan yang menurut Anda salah.
3. **Closed beta**, maksimal 25 freelancer undangan, selama **dua minggu**. Syarat lulusnya:
   - tidak ada Sev-1 (`unverified_excerpt_displayed`, `cross_user_access`);
   - minimal **5 orang** menyelesaikan alur pendaftaran → laporan tanpa bantuan;
   - ada umpan balik tentang apakah temuannya berguna.

   Sesudah minggu pertama beta, tinjau ulang **batas volume alert (3 kegagalan)**, lalu ukur ulang angka README (biaya, tingkat kegagalan, tingkat tangkapan) dari data beta.
4. **Publik** hanya setelah ketujuh item DoD lulus dan beta selesai.

## Yang masih terutang dari sisi engineering

Ini bukan tugas Anda, tetapi perlu Anda ketahui:

- sumber backup untuk `backup-verify` di Render;
- kotak surat yang bisa dibaca TR-24 di staging;
- endpoint laporan pelanggaran CSP;
- tampilan saat database mati ketika halaman dimuat ulang (sekarang muncul halaman masuk, bukan pesan gangguan).

Detailnya ada di [staging-setup.md](staging-setup.md), bagian "Known gaps".
