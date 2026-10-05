# Quarry

Tauri v2 (Rust) + React ile yazılmış, **modüler ve temalı bir veritabanı stüdyosu**.
Bugün **MySQL 5.6** ve **PostgreSQL** destekler; mimari Redis, MongoDB, ClickHouse
ve diğerlerini yalnızca yeni bir adaptör yazarak eklemeye izin verir.

> Adı "taş ocağı"ndan gelir: veriyi kazıp çıkarırsınız, ikonundaki düğüm ağı ise tek bir
yerden birbirine bağlanan veritabanlarını simgeler — düğümlerin renkleri uygulamanın
beş vurgu paletinden alınmıştır.

![uygulama](src-tauri/app-icon.png)

## Neden modüler?

Uygulamanın tamamı tek bir soyutlama üzerine kuruludur:

```
                 ┌───────────────────────────────┐
   Frontend  →   │  Tauri komutları (commands.rs) │  → sürücüden habersiz
                 └───────────────┬───────────────┘
                                 │
                 ┌───────────────▼───────────────┐
                 │   DriverRegistry  (registry)   │
                 └───────┬───────────────┬────────┘
                         │               │
                 ┌───────▼─────┐  ┌──────▼──────┐
                 │  MySQL      │  │ PostgreSQL  │   … Redis / Mongo / ClickHouse
                 │  adapter    │  │  adapter    │
                 └─────────────┘  └─────────────┘
```

İki trait her şeyi tanımlar (`src-tauri/src/drivers/mod.rs`):

| Trait | Rolü |
| --- | --- |
| `DatabaseDriver` | Bir motoru temsil eder: kimlik, yetenekler, dinamik form şeması, `test()` ve `connect()` |
| `Connection` | Açık bir bağlantı: `list_databases`, `list_namespaces`, `list_objects`, `describe_object`, `execute` |

Arayüz hiçbir zaman sürücüye özel kod içermez. Farklar iki mekanizmayla taşınır:

- **`DriverCapabilities`** — `supportsSchemas`, `isRelational`, `resultShape`, `objectKinds`,
  `supportsTransactions` … Frontend hangi paneli göstereceğine bu bayraklara göre karar verir.
  Örneğin MySQL şema katmanı olmadığı için `supportsSchemas: false` döner ve ağaç şema
  seviyesini atlar; PostgreSQL ise şemaları gerçek bir seviye olarak gösterir.
- **`configFields`** — bağlantı formu sürücünün tanımladığı alanlardan üretilir.

## Yeni bir veritabanı eklemek

1. `src-tauri/src/drivers/<motor>.rs` dosyasını aç ve `DatabaseDriver` + `Connection` trait'lerini
   implement et (MySQL/PostgreSQL dosyaları şablon olarak kullanılabilir).
2. `src-tauri/src/drivers/mod.rs` içindeki `DriverRegistry::with_builtins()` fonksiyonuna
   `registry.register(Arc::new(MyDriver::new()));` satırını ekle.
3. Bağımlılığı `Cargo.toml`'a ekle.

**IPC katmanı, `commands.rs` ve arayüzde tek satır değişmez.** Sürücü bir sonraki açılışta
otomatik olarak `list_drivers` çıktısında görünür, bağlantı formu kendiliğinden oluşur.

## Teknoloji yığını

**Arka uç (Rust)** — Tauri v2, `tokio`, `sqlx` (MySQL + PostgreSQL, rustls), `aes-gcm`
(şifreler için şifrelenmiş yerel kasa), `serde`, `thiserror`, `tracing`.

**Ön yüz** — React 19 + TypeScript + Vite, Tailwind CSS v4, shadcn tarzı bileşenler,
`zustand`, CodeMirror 6 (SQL), `@tanstack/react-virtual` (sonuç grid'i), `lucide-react`.

## Proje yapısı

```
src-tauri/
  src/
    commands.rs        # IPC yüzeyi (sürücüden habersiz)
    drivers/
      mod.rs           # trait'ler, yetenekler, registry
      mysql.rs         # MySQL 5.6+ adaptörü
      postgres.rs      # PostgreSQL adaptörü
    ddl.rs             # diyalekte duyarlı DDL üretici (create/alter/index/drop) + testler
    models.rs          # serde DTO'ları (frontend tipleriyle birebir)
    session.rs         # açık bağlantı yöneticisi + çalışan sorgu kaydı (iptal)
    secrets.rs         # şifrelenmiş yerel kasa (AES-256-GCM)
    store.rs           # profil + ayar + kayıtlı sorgu kalıcılığı (JSON)
    sql_split.rs       # tırnak/yorum duyarlı SQL ayırıcı (+ testler)
src/
  components/          # layout, ui, connections, explorer, query, objects, history, snippets, settings
  lib/                 # tipli IPC, tipler, dev mock, yardımcılar
  stores/              # tema + çalışma alanı durumu
  theme/               # palet tanımları
```

## Kurulum

```bash
npm install
npm run tauri:dev      # masaüstü uygulamasını geliştirme modunda çalıştır
npm run tauri:build    # imzalı/paketlenmiş uygulama üret
```

Sadece arayüz üzerinde çalışmak için:

```bash
npm run dev            # http://localhost:1420 — tarayıcıda demo verisiyle açılır
```

> **Tarayıcı demo modu:** Tauri kabuğu dışında (`__TAURI_INTERNALS__` yokken) `src/lib/mock.ts`
> devreye girer ve örnek bağlantı/şema/sonuç verisi üretir. Paketlenmiş uygulamada bu yol
> asla çalışmaz.

## Kalite kontrolleri

```bash
npm run typecheck                      # tsc --noEmit
npm run build                          # tsc + vite build
cargo test  --manifest-path src-tauri/Cargo.toml
cargo check --manifest-path src-tauri/Cargo.toml
```

Gerçek bir sunucuya karşı sürücüyü uçtan uca denemek için (varsayılan olarak atlanır):

```bash
QUARRY_TEST_MYSQL_HOST=127.0.0.1 \
QUARRY_TEST_MYSQL_USER=root \
QUARRY_TEST_MYSQL_PASSWORD=secret \
QUARRY_TEST_MYSQL_DATABASE=shop \
cargo test --manifest-path src-tauri/Cargo.toml -- --ignored --nocapture
```

## MySQL 5.6 notları

- **TLS**: 5.6.46 öncesi sürümler TLS 1.2 desteklemez. Bağlantı formundaki **TLS** alanını
  `Disabled` yapın; varsayılan `Preferred` sunucu destekliyorsa şifreler, desteklemiyorsa
  düz bağlantı kullanır.
- Şema keşfi yalnızca 5.6'da var olan `information_schema` tablolarını kullanır.
- Tip eşlemesi: `DECIMAL` hassasiyet kaybı olmadan **string** olarak, `BLOB/BINARY` `base64:`
  önekli, `DATE/DATETIME/TIMESTAMP` ISO string olarak, `NULL` boş string'den ayrı olarak taşınır.
- Büyük sonuçlar sunucudan akıtılır ve ekranda `editor.maxRows` ayarında kesilir (`truncated` bayrağı).
- Çok bildirimli script'ler tırnak/yorum duyarlı biçimde ayrıştırılıp sırayla çalıştırılır.
- `SELECT VERSION()` sonucu ayrıştırılıp `ServerInfo` içinde saklanır.
- Keşif sorgularındaki **takma adlar hiçbir zaman rezerve kelime değildir** (veya ters tırnakla
  korunur). 5.6, `CURRENT_USER` gibi rezerve kelimeleri tırnaksız alias olarak kabul etmez;
  bu yüzden `... AS current_usr` gibi nötr adlar kullanılır.

## Editör ve IntelliSense

SQL editörü (CodeMirror 6) bağlı olduğunuz veritabanının **şemasını bilir**:

- **Tablo adları** — `SELECT * FROM ord…` yazarken tablolar önerilir.
- **Kolon adları ve tipleri** — `orders.` yazdığınızda kolonlar, yanlarında `decimal(12,2)`,
  `enum('new','paid','shipped')` gibi tipleriyle listelenir.
- **Nitelikli erişim** — hem `orders.id` hem `shop.orders.id` çalışır.
- **Anahtar kelimeler ve fonksiyonlar** — seçilen lehçeye (MySQL / PostgreSQL) göre.
- Ayrıca `⌘/Ctrl + Space` ile elle tetikleme, `⌘/Ctrl + Enter` ile çalıştırma.

Şema bilgisi tek bir turda gelir: her sürücü `list_table_columns` çağrısını tek bir
`information_schema` sorgusuyla karşılar (trait'teki varsayılan uygulama ise tabloları tek tek
`describe_object` ile gezerek her sürücü için doğru çalışır). Sonuç `sessionId||database`
anahtarıyla önbelleğe alınır, editör yeniden açıldığında tekrar sorgulanmaz.

## Tema

Light / Dark / System + beş renk paleti (Indigo, Ocean, Sunset, Forest, Rose). Tüm renkler
`src/index.css` içindeki CSS değişkenleriyle tanımlıdır ve `data-palette` ile `.dark`
seçicileri üzerinden değişir; tema seçimi `localStorage`'da saklanır.

## Sorgu çalışma tezgâhı

- **Çalıştır / Durdur** — uzun süren bir sorgu `Stop` düğmesiyle (veya `⌘/Ctrl + .`) durdurulur.
  Her iki SQL sürücüsü de `supportsCancel: true` döner: çalışan bağlantının sunucu taraflı
  kimliği alınır (`SELECT CONNECTION_ID()` / `pg_backend_pid()`) ve iptal, ayrı bir bağlantıdan
  `KILL QUERY` / `pg_cancel_backend` ile uygulanır. `QueryRequest.timeoutMs` de aynı mekanizmayı
  kullanarak çalışan sorguyu durdurur.
- **EXPLAIN** — `Explain` düğmesi (`⌘/Ctrl + Shift + Enter`) ifadeyi sürücünün `EXPLAIN`
  biçimine sarıp planı ayrı bir tabloda gösterir.
- **Kayıtlı sorgular** — editördeki sorgu ad verilerek kaydedilir; `Saved queries` panelinden
  çalıştırılır, yeni sekmeye eklenir veya silinir. Sürücü/veritabanı ipucu saklanır ve uygun bir
  oturum açıksa sorgu o sürücüde çalıştırılır.

## Gezgin ağacı ve nesne grupları

Gezginde her veritabanı (PostgreSQL'de her şema) altındaki nesneler **türüne göre gruplanır** ve
her grup başlık + sayı ile gösterilir: **Tables, Views, Materialized views, Collections,
Keyspaces, Functions, Procedures, Triggers, Events, Sequences, Other**. Grup başlığına tıklayarak
grubu katlayıp açabilirsiniz (varsayılan: açık); nesneler kendi gruplarının altında listelenir.

- Veritabanı listesi otomatik tazelenir: pencere yeniden öne geldiğinde (focus) ve
  `CREATE/DROP DATABASE|SCHEMA` çalıştıran bir sorgudan sonra; böylece başka bir istemcinin
  açtığı veritabanı **Refresh**'e basmadan görünür (`src/lib/sqlIntent.ts`).
- Pencere öne geldiğinde (focus/visibility) **açık durumdaki** düğümlerin içeriği de yeniden
  okunur: veritabanı/şema altındaki tablolar, view'lar vb. dışarıda oluşturulmuşsa elle
  **Refresh**'e basmadan ağaçta görünür.
- Ağaç durumu (açılmış veritabanları, yüklenmiş nesneler ve grup katlanma durumu) gezinme
  sırasında korunur; başka bir kenar çubuğu sekmesine geçip dönünce ağaç katlanmaz
  (`src/lib/explorerTree.ts`). Bağlantı kapatıldığında o oturuma ait önbellek temizlenir,
  böylece uzun süre açık kalan uygulama eski bağlantıların ağaçlarını biriktirmez.
- Önbellek sınırlıdır: bir ağaç = bir oturum + veritabanı (altındaki tüm şema ve nesne
gruplarıyla). En fazla **64** ağaç tutulur; en eski görüntülenenler LRU ile atılır, böylece
yüzlerce veritabanı gezen çok uzun bir oturum önbelleği sınırsız büyütemez. Bir ağacın
verisi okunduğunda/veritabanı açıldığında “en son görüntülenen” olarak işaretlenir ve
arayan yazımlar (panel durumu geri yansıtılırken) üst sınırı aşamaz.
- Sıra ve etiketler `src/lib/objects.ts` içindeki `OBJECT_KIND_ORDER` / `OBJECT_KIND_LABEL` ile
  tanımlıdır; yeni bir tür eklemek tek satırdır. Bilinmeyen bir tür `Other` grubuna düşer, böylece
  yeni bir sürücü nesneleri "kaybettiremez".
- Sınıflandırma sürücü tarafındadır: her introspection sorgusu normalize edilmiş bir tür işareti
  döndürür ve `drivers::object_kind_from_marker` bunu tek bir yerde `ObjectKind`'a çevirir.
- Keşif kapsamı: MySQL `information_schema.TABLES` yanında `TRIGGERS`, `ROUTINES`
  (FUNCTION/PROCEDURE) ve `EVENTS`; PostgreSQL ise `tables` yanında `sequences`, `routines` ve
  kullanıcı tanımlı `pg_trigger` kayıtlarını da listeler (dahili trigger'lar hariç).

## Tablo bağlam menüsü ve obje inceleyici

Gezgin ağacında bir tabloya/görünüme **sağ tıklayınca** bağlam menüsü açılır; sol tıklama ise
doğrudan obje sekmesini (inceleyici) açar. Menü sürücünün bildirdiği yetilere göre üretilir
(`DriverCapabilities.supportedActions`) — arayüz sürücü-özel kod içermez.

- **Görüntüle:** yapıyı incele (Columns / Indexes / Foreign keys / DDL sekmeleri), veriyi aç
  (200 satır), satırları say, DDL/kolon/index/FK bilgisi.
- **Kopyala:** ad, tam ad, DDL.
- **Şablon:** SELECT / INSERT / UPDATE / DELETE — kolonlardan üretilir.
- **Dışa aktar:** CSV / JSON / SQL INSERT (tarayıcıdan indirilir).
- **Yapı:** index oluştur (kolon sırası + unique + tip, canlı SQL önizleme), kolon ekle/değiştir/sil.
- **Tablo:** yeniden adlandır, kopyasını oluştur, bakım (OPTIMIZE/ANALYZE/VACUUM), yeniden indeksle.
- **Yıkıcı:** truncate ve drop; ikisi de **tablo adını yazarak** onay ister.

Yazma işlemleri tipli bir `ObjectActionRequest` ile backend'e gider ve `src-tauri/src/ddl.rs`
içinde diyalekt SQL'ine dönüştürülür; kimlikler her zaman `quote_identifier` ile tırnaklanır,
kullanıcı girdisi SQL'e ham string olarak girmez.

Sonuç grid'inde de hücre sağ tık menüsü (değeri/satırı kopyala) ve CSV/JSON dışa aktarma vardır.

## Grid satır düzenleme

`View data` ile açılan bir **tablo** önizlemesinde grid üstünde **Edit rows** düğmesi çıkar.
Düzenleme yalnızca primary key'i olan, tek bir `SELECT` sonucu için açılır; PK'sız tablolarda
düğme nedenini belirterek devre dışı kalır.

- **Hücre düzenleme:** düzenleme modunda PK dışı hücreler input olur; kirlenen satırlar vurgulanır.
- **Satır ekleme:** "Add row" boş bir taslak satır açar; auto-increment PK boş bırakılırsa sunucu atar.
- **Satır silme:** satır seçip "Delete" → onay diyaloğu.
- **Kaydet / Vazgeç:** "Save (n)" bekleyen değişiklikleri gönderir, sonra önizlemeyi tazeler.

Her değişiklik tipli bir `RowChangeRequest` ile backend'e gider; SQL (`INSERT`/`UPDATE`/`DELETE`)
`src-tauri/src/ddl.rs` içinde üretilir ve değerler `NULL`/sayı/bool/metin olarak kaçışlanır.
`apply_row_change` komutu **PK'yı kapsamayan** bir güncelleme/silmeyi reddeder, böylece yanlışlıkla
tüm tablo değiştirilemez. Masaüstünde gerçek sunucuya, tarayıcı önizlemesinde mock veriye yazılır.

## Yeni tablo oluşturma, sayfalama ve toplu kaydetme

- **Yeni tablo:** Gezgin başlığındaki **＋** düğmesi sihirbazı açar. Kolonları (ad, tip, nullable,
  default, PK, auto-increment, yorum), tablo adını ve yorumu tanımlarsınız; **canlı SQL önizlemesi**
  gösterilir. Backend `ddl::create_table_from_columns` doğrulamayı yapar (boş ad, yinelenen kolon,
  birden fazla AUTO_INCREMENT, AUTO_INCREMENT'in PK olmaması reddedilir) ve diyalekt SQL üretir.
  Oluşturma sonrası nesne ağacı `objectsRevision` ile kendini yeniler.
- **Sayfalama:** `View data` önizlemesinde **Prev / Next** ile `LIMIT … OFFSET …` yeniden üretilir;
  aralık ("201–440") önizleme başlığında görünür. Editör metni de aynı sorguya güncellenir.
- **Tip-doğru düzenleme:** Satır değerleri kolon tipine göre `coerce` edilir; sayısal kolonlar
  (int/decimal/float…) sunucuya sayı olarak gider, `'…'` string olarak değil. Metin/bool/null korunur.
- **Toplu kaydetme:** Bir grid kaydı tek `apply_row_changes` çağrısıyla gider; tablo şeması satır
  başına değil **tablo başına bir kez** okunur, böylece büyük bir kayıt tek introspection turu eder.
- **Ayarlar (bildirimsel kayıt):** Tüm ayarlar `src/lib/settings.ts` içindeki tek bir
  `SETTINGS_REGISTRY`'den türetilir — `AppSettings` tipi, varsayılanlar, yükleme anındaki
  doğrulama (coercion) ve ayar paneli ondan üretilir. Yeni bir ayar eklemek tek bir kayıt
  girdisidir; senkron tutulacak ikinci bir liste yoktur. Değerler `get_settings`/`set_settings`
  ile `settings.json`'a olduğu gibi yazılır; bilinmeyen anahtarlar düşürülür, aralık dışı
  değerler kırpılır (eski veya elle düzenlenmiş dosya uygulamayı bozmaz). Tema localStorage ile
  ilk boyamada da uygulanır. Bölümler:
  - **Appearance:** yoğunluk (comfortable/compact), mono font boyutu, mono font ailesi, zebra satırlar.
  - **Query editor:** satır limiti, zaman aşımı, satır kaydırma, satır numaraları, aktif satır
    vurgusu, otomatik tamamlama, katlama oluğu, sekme boyutu.
  - **Results:** önizleme sayfa boyutu, NULL gösterimi, kolon tiplerini göster, hücre kopyalama biçimi.
  - **Safety:** satır silme onayı, kaydedilmemiş değişiklik uyarısı, WHERE'siz UPDATE/DELETE engeli.
  - **General:** yıkıcı işlemler için isim yazma onayı, bildirim süresi.
  - **Restore defaults** düğmesi tüm ayarları varsayılana döndürür.

## Bilinen sınırlar / sonraki adımlar

- Rust tiplerinden otomatik TypeScript üretimi (`tauri-specta`) yerine tipler elle
  senkronize edilmektedir; şema sabit kaldığı sürece bu bilinçli bir tercihtir.
- Canlı veritabanına karşı entegrasyon testleri (testcontainers) henüz eklenmedi; DDL/`VACUUM`
  gibi işlemler gerçek sunucu olmadan yalnızca SQL üretimi düzeyinde doğrulanır.
- MySQL 5.6 prepared-statement kısıtı (bkz. aşağıdaki notlar) bazı DDL ifadelerini etkileyebilir;
  hata olduğu gibi gösterilir.
- Satır düzenleme yalnızca PK'li tablo önizlemelerinde çalışır (join/agregasyon sonuçlarında değil);
  değerler metin/sayı/bool/null olarak temsil edilir, tarih/blob/binary türleri metne dönüşür.
- Yeni tablo sihirbazı v1 yalnızca kolonları kapsar; index ve yabancı anahtarlar oluşturma sonrası
  mevcut diyaloglarla eklenir. Canlı SQL önizlemesi Rust üretiminin TS kopyasıdır (proje konvansiyonu).
- Tarayıcı mock'unda `create_table` ve settings yalnızca bellek-içi simüle edilir; gerçek kalıcılık ve
  şema değişikliği masaüstü backend'ini gerektirir.
- `Require WHERE on UPDATE/DELETE` denetimi ifadeyi basit bir anahtar kelime taramasıyla inceler;
  tırnak/yorum içindeki `WHERE` kelimesi de eşleşebilir (kaba ama güvenli tarafta bir denetim).
- Ek nesne keşfi sorguları (trigger/routine/event/sequence) canlı bir sunucu olmadan yalnızca SQL
  düzeyinde ve ortak sınıflandırma birim testiyle doğrulanır; yetki kısıtları sunucuda sorguyu
  sınırlayabilir (satırlar filtrelenir, hata döndürmez).
- ERD görselleştirme hâlâ yol haritasında.
- Tamamlama ağacına en fazla 400 tablo beslenir; çok büyük şemalarda kalan tablolar
  atlanır (editör yanıt vermeye devam eder).

## Yardımcı scriptler

| Komut | Ne yapar |
| --- | --- |
| `npm test` | Node'un yerleşik test koşucusuyla ayar kaydını doğrular (birleştirme, aralık kırpma, select doğrulama, noktalı yol okuma/yazma) |
| `npm run icon` | İkonu çizer (`scripts/generate-icon.mjs`) ve tüm platform boyutlarını (`icns`, `ico`, Android/iOS) üretir |
| `npm run preview:html` | Uygulamayı tek dosyalık `preview.html` olarak paketler (tarayıcıda incelemek için) |
| `node scripts/build-icon-sheet.mjs` | İkonu 512/256/128/64/32 px boyutlarında açık ve koyu zeminde gösteren `icon-sheet.html` üretir |

İkon `scripts/generate-icon.mjs` içinde **kod olarak** tanımlıdır: harici görsel dosya ya da
bağımlılık yok, sadece Node'un `zlib`'i ile PNG üretilir. Rengi değiştirmek için dosyadaki
`PALETTE` dizisini düzenleyip `npm run icon` çalıştırmak yeterlidir.
