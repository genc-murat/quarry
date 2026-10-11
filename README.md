# Quarry

Tauri v2 (Rust) + React ile yazılmış, **modüler ve temalı bir veritabanı stüdyosu**.
Bugün **MySQL 5.6**, **PostgreSQL**, **SQLite**, **Redis**, **MongoDB** ve **ClickHouse** destekler;
mimari yeni motorları yalnızca yeni bir adaptör yazarak eklemeye izin verir.

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
                 └──┬──────────┬──────────┬─────┬──┘
                    │          │          │     │
             ┌──────▼────┐ ┌───▼──────┐ ┌─▼────┐ ┌▼────────┐
             │  MySQL    │ │PostgreSQL│ │SQLite│ │  Redis  │   … MongoDB, ClickHouse
             │  adapter  │ │ adapter  │ │adptr │ │ adapter │
             └───────────┘ └──────────┘ └──────┘ └─────────┘
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
   implement et (MySQL/PostgreSQL/SQLite/Redis dosyaları şablon olarak kullanılabilir).
2. `src-tauri/src/drivers/mod.rs` içindeki `DriverRegistry::with_builtins()` fonksiyonuna
   `registry.register(Arc::new(MyDriver::new()));` satırını ekle.
3. Bağımlılığı `Cargo.toml`'a ekle.
4. Tarayıcı mock'unu da besle (§Kalite kontrolleri): sürüklenme denetiminin farkı gösterebilmesi
   için önce `src/lib/fixtures/driver-descriptors.json`'ı yenile, sonra `src/lib/mockFixtures.ts`
   içine motorun `EngineFixture`'ını ekleyip `npm run check:drift` yeşile gelene kadar hizala.

**IPC katmanı, `commands.rs` ve arayüzde tek satır değişmez.** Sürücü bir sonraki açılışta
otomatik olarak `list_drivers` çıktısında görünür, bağlantı formu kendiliğinden oluşur.

Motor kendi tırnak diyalektini (`DatabaseDriver::dialect`) ve bir okumanın nasıl açıklanacağını
(`DatabaseDriver::explain_statement`, açıklayamıyorsa `None`) sürücü üzerinde bildirir; her bağlantı
açıldığı sürücüyü taşır ve kimliğini, yeteneklerini ve bu iki soruyu yalnızca oradan yanıtlar,
dolayısıyla tek bir uygulama kalır ve mock denetimi bunları görebilir.

Sürücü obje inceleyicisine kendi sekmelerini de ekler: `Connection::inspect_sections` ile panel
bildirir, `section_body` ile talep üzerine yenilenen gövdeyi verir, `run_section_action` ile bölümün
gösterdiği işlemleri çalıştırır. Böylece `ObjectDetail` DTO'suna motor-özel alan eklenmez; sekme
çizimi tamamen genel bloklardan (alanlar/tablo/kayıt listesi) yapılır.

## Teknoloji yığını

**Arka uç (Rust)** — Tauri v2, `tokio`, `sqlx` (MySQL + PostgreSQL + SQLite, rustls), `redis`
(bağlantı havuzu + rustls TLS), `aes-gcm`
(şifreler için şifrelenmiş yerel kasa), `serde`, `thiserror`, `tracing`.

**Ön yüz** — React 19 + TypeScript + Vite, Tailwind CSS v4, shadcn tarzı bileşenler,
`zustand`, CodeMirror 6 (SQL — yalnız ilişkisel sürücülerde), `@tanstack/react-virtual`
(sonuç grid'i), `lucide-react`.

## Proje yapısı

```
src-tauri/
  src/
    commands.rs        # IPC yüzeyi (sürücüden habersiz)
    drivers/
      mod.rs           # trait'ler, yetenekler, registry
      mysql.rs         # MySQL 5.6+ adaptörü
      postgres.rs      # PostgreSQL adaptörü
      sqlite.rs        # SQLite adaptörü (gömülü; uçtan uca testleri sunucu gerektirmez)
      redis.rs         # Redis adaptörü (komut başına satır; yanıt→satır eşlemesi + testler)
      mongo.rs         # MongoDB adaptörü (JSON komut belgeleri; cursor okuma + testler)
      clickhouse.rs    # ClickHouse adaptörü (HTTP; sistem tabloları + testler)
    ddl.rs             # diyalekte duyarlı DDL üretici (create/alter/index/drop) + testler
    models.rs          # serde DTO'ları (frontend tipleriyle birebir)
    session.rs         # açık bağlantı yöneticisi + çalışan sorgu kaydı (iptal)
    secrets.rs         # şifrelenmiş yerel kasa (AES-256-GCM)
    store.rs           # profil + ayar + kayıtlı sorgu kalıcılığı (JSON)
    sql_split.rs       # tırnak/yorum duyarlı SQL ayırıcı (+ testler)
src/
  components/          # layout, ui, connections, explorer, query, objects, history, snippets, settings
  lib/                 # tipli IPC, tipler, dev mock (fikstürler + yanıt eşlemesi), yardımcılar
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
> devreye girer. Veriyi `src/lib/mockFixtures.ts` içindeki **motor başına fikstür** üretir: her
> derlenmiş sürücü için profil, oturum, veritabanı/şema, nesne ağacı, introspection, EXPLAIN planı,
> diyalekt tırnaklaması, satır tahminleri ve sürücünün bildirdiği inspector bölümleri burada
> tanımlıdır. `list_drivers`, `list_connections`, `list_sessions` ve tüm introspection komutları bu
> tablodan üretildiği için yeni bir motor eklemek tek bir girdi eklemektir; fikstürlerin
> adaptörlerle tutarlılığını `src/lib/mock.test.ts` doğrular. Komutların yapay gecikmesi
> `mockLatency` ile ayarlanır (`min`/`max` = 0 → beklemesiz; testler bunu kullanır). Paketlenmiş
> uygulamada bu yol asla çalışmaz.

## Kalite kontrolleri

```bash
npm run typecheck                      # tsc --noEmit
npm run build                          # tsc + vite build
cargo test  --manifest-path src-tauri/Cargo.toml
cargo check --manifest-path src-tauri/Cargo.toml
```

SQLite gömülü olduğu için sürücü testleri (`:memory:` ve geçici dosya ile) **sunucu olmadan**
normal test koşusunda çalışır.

**Mock ↔ Rust sürüklenme denetimi.** Tarayıcı mock'u her motorun yüzeyini yeniden bildirdiği için
`src/lib/fixtures/driver-descriptors.json` iki dil arasındaki sözleşmedir. Rust tarafındaki
`descriptor_snapshot_matches_the_registry` testi bu dosyayı kayıt defterine karşı, TypeScript
tarafındaki `src/lib/fixtureDrift.test.ts` ise `src/lib/mockFixtures.ts`'i bu dosyaya karşı doğrular.
Bir yetenek bayrağı, nesne türü, bağlam menüsü eylemi, bağlantı alanı, tanımlayıcı tırnak karakteri
ya da `EXPLAIN` ifadesi yalnızca bir tarafta kalırsa test kırmızıya döner — sessizce ayrışamazlar.
Sürücü bu iki olguyu `DatabaseDriver::dialect` ve `DatabaseDriver::explain_statement` ile kendisi
bildirir; her bağlantı açıldığı sürücüyü taşıyıp kimliğini, yeteneklerini ve bu iki olguyu yalnızca
oradan yanıtlar. `npm test` tarafı da mock'un `explain_query` yanıtını doğrudan bu bildirimle
karşılaştırır. Bir sürücüyü bilerek değiştirdikten sonra:

```bash
QUARRY_UPDATE_SNAPSHOT=1 cargo test --manifest-path src-tauri/Cargo.toml descriptor_snapshot
npm run check:drift   # iki yarıyı birlikte koşar
```

Gerçek bir sunucuya karşı sürücüyü uçtan uca denemek için (varsayılan olarak atlanır):

```bash
QUARRY_TEST_MYSQL_HOST=127.0.0.1 \
QUARRY_TEST_MYSQL_USER=root \
QUARRY_TEST_MYSQL_PASSWORD=secret \
QUARRY_TEST_MYSQL_DATABASE=shop \
cargo test --manifest-path src-tauri/Cargo.toml -- --ignored --nocapture
```

Redis için aynı koşuya `QUARRY_TEST_REDIS_HOST` (isteğe bağlı `_PORT`, `_USER`, `_PASSWORD`) verin.
MongoDB için `QUARRY_TEST_MONGO_HOST`, ClickHouse için `QUARRY_TEST_CLICKHOUSE_HOST` (her ikisinde de
isteğe bağlı `_PORT`, `_USER`, `_PASSWORD`) kullanılır.

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

## SQLite notları

- **Gömülü dosya**: Sunucu yok; bağlantı formu yalnızca **Database file** yolu ve
  **Create if missing** seçeneğinden oluşur. `:memory:` yazılırsa tek bir bağlantıya sabitlenmiş
  bellek-içi veritabanı açılır. Bağlantı profilleri `user@host` yerine dosya yolunu gösterir.
- **Şema katmanı yok**: `main` (ve o bağlantıda `ATTACH` edilmiş) veritabanları ağacın kök
  seviyesidir; nesneler `sqlite_master`'dan okunur ve tablo/view/trigger olarak gruplanır.
  `ATTACH` bağlantıya özeldir, havuzun başka bir bağlantısında görünmeyebilir.
- **İnceleme**: Kolonlar `pragma_table_info`, index'ler `pragma_index_list`/`pragma_index_info`,
  yabancı anahtarlar `pragma_foreign_key_list` tablo-değerli fonksiyonlarıyla tek tek okunur;
  editör otomatik tamamlama için tüm kolonlar tek sorguda (`sqlite_master` ⋈ `pragma_table_info`)
  toplanır.
- **Otomatik artan anahtar**: Tek kolonlu `INTEGER PRIMARY KEY` (rowid alias) auto-increment
  sayılır, böylece grid'de boş bırakılan PK'yı SQLite atar. Şemadan DDL üretilirken bu kolon
  `INTEGER PRIMARY KEY AUTOINCREMENT` olarak yazılır; MySQL'e özgü `ENGINE`/`KEY`/`AFTER`/`COMMENT`
  ekleri ve PostgreSQL'e özgü `CASCADE`/`USING HASH` SQLite diyalektinde üretilmez.
- **DDL farkları**: `TRUNCATE` yerine `DELETE FROM`, `DROP TABLE ... CASCADE` yok, `VACUUM` tablo
  argümanı almaz, index'ler `CREATE TABLE` gövdesinde değil ayrı `CREATE INDEX` ifadelerinde
  üretilir. `ALTER COLUMN` yalnızca kolon **yeniden adlandırmayı** destekler; tip/kısıt değişimi
  SQLite'ta tablo yeniden oluşturmayı gerektirdiği için reddedilir.
- **EXPLAIN**: `EXPLAIN QUERY PLAN` kullanılır (düz `EXPLAIN` VDBE opcode'ları döker).
- **İptal**: Gömülü olduğu için sunucu taraflı `supportsCancel` **kapalıdır**; zaman aşımı yine
  de çalışır (IPC katmanı geleceği düşürür).
- **Tipler**: SQLite dinamik tipli; `BLOB` `base64:` önekli, `REAL` sayı, `TEXT` string, `NULL`
  ayrı taşınır. `INTEGER`/`REAL`/`BLOB`/`TEXT` afiniteleri bilinir, kalan değerler değerin kendi
  depolama sınıfına göre çözülür.

## Redis notları

- **İlişkisel değil**: `queryLanguage: redis`, `resultShape: keyValue`, `isRelational: false`.
  Arayüz bu bayraklara göre SQL'e özgü her şeyi gizler: şema ağacı, tablo sihirbazı,
  qualified name / DDL kopyalama, SELECT/INSERT/UPDATE/DELETE şablonları, SQL otomatik tamamlama
  ve `EXPLAIN`. Editör, SQL lehçesi yerine düz metin moduna geçer.
- **Komutlar**: Editör metnindeki her boş olmayan satır bir Redis komutudur (satır başına bir
  komut; tırnak/kaçış destekli bağımsız değişkenlerle, `#` yorumları atlanır). Örn:
  `SET user:1 Ada` satırı, `GET user:1` satırı. Bu, `redis-cli`'den yapıştırılan script'lerle
  uyumludur.
- **Yanıt gösterimi**: Skaler yanıt tek hücreye (`value`), skaler diziler eleman başına bir satıra,
  iç içe diziler `col_1`, `col_2` matrisine, RESP3 map ise `field`/`value` tablosuna dönüştürülür.
  `editor.maxRows` sınırı aynı şekilde uygulanır (`truncated` bayrağı).
- **Gezgin**: Anahtarlar `SCAN` ile (en fazla **2000** anahtar / 40 tur) listelenir ve `Keys`
  grubunda gösterilir; çok büyük keyspace'lerde liste örneklemdir, tamamı değil. Bir anahtara
  tıklamak `TYPE`/`TTL`/`<tip>LEN`/`STRLEN` özetini gösterir; DDL sekmesi uydurma bir
  `CREATE TABLE` yerine anahtarın tipini ve çalıştırılabilir bir komutu yazar.
- **Tek veritabanı**: Oturum, bağlantı formundaki numaralı veritabanına sabitler
  (`supportsMultipleDatabases: false`); `SELECT` ile canlı geçiş yapılmaz.
- **TLS**: `Required` seçilirse `rediss://` ile sistem sertifika deposu üzerinden bağlanılır;
  `Disabled` düz `redis://` kullanır. `Preferred` (varsayılan dışı) düz bağlantı sayılır.
- **Kimlik**: `username`/`password` URL'ye yüzde-kodlanarak yazılır; Redis 6 öncesi ACL kullanmayan
  sunucularda yalnızca `password` gerekir.

## MongoDB notları

- **Belge tabanlı**: `queryLanguage: mongo`, `resultShape: document`, `isRelational: false`.
  Gezgin koleksiyon ve view'ları listeler; SQL şablonları, DDL ve `EXPLAIN` sunulmaz.
- **Komutlar**: Editör metni JSON komut belgeleridir, örn. `{"find": "users", "filter": {"age": {"$gt": 21}}}`.
  Birden fazla komut art arda yazılabilir (virgül ya da noktalı virgülle ayrılabilir); `//` ve `#`
  ile başlayan satırlar yorumdur. Mongo shell sözdizimi (`db.users.find(...)`) desteklenmez.
- **Yanıt**: `find` ve `aggregate` imleçleri `getMore` ile satır limitine kadar okunur; diğer
  komutların yanıtı tek satır olarak gösterilir. Üst düzey alanlar kolon olur, iç içe değerler JSON
  olarak kalır, BSON tipleri extended JSON (`$oid`, `$date`…) ile gösterilir.
- **Veri önizlemesi**: `View data` `_id`'ye göre sıralı bir `find` ile sayfalanır (`skip`/`limit`).
  Sıralama sabittir; filtre ya da sıralama arayüzü yoktur.
- **Şema**: Kolonlar 200 belgelik bir örneklemden çıkarılır (birden çok tip birleşir; eksik ya da
  null alanlar nullable olur). İndeksler `listIndexes` ile okunur.
- **Düzenleme**: Koleksiyon satırları grid'de düzenlenemez. Yazma komutları (insert, update, delete)
  editörden JSON olarak çalıştırılabilir.
- **Eylemler**: Inspect, View data, Count rows ve Copy name. Rename, drop ve truncate yoktur.
- **Bağlantı ve TLS**: Yalnızca `Required` TLS seçeneği vardır (`?tls=true`, sistem sertifika deposu).
  Kimlik doğrulama veritabanı, bağlantıdaki veritabanıdır; boşsa `admin`. Ayrı bir `authSource`
  alanı yoktur. Kullanıcı adı ve parola URI'de yüzde-kodlanır.
- **İptal**: Sunucu tarafı iptal yoktur (`supportsCancel: false`). IPC zaman aşımı yanıtı bırakır, ancak
  sunucudaki komut çalışmaya devam edebilir.
- **Test kapsamı**: Komut ayrıştırıcısı, BSON dönüşümü ve şema çıkarımı birim testleriyle; cursor okuma,
  satır sınırı ve sayfalama canlı bir `mongod`'a karşı doğrulanır.

## ClickHouse notları

- **Bağlantı**: HTTP arayüzü kullanılır (varsayılan port 8123). Yalnızca düz HTTP desteklenir; bağlantı
  formunda TLS alanı yoktur. Veritabanı alanı boş bırakılırsa sunucunun varsayılanı geçerlidir.
- **İlişkisel, şemasız**: Veritabanları `system.databases`'ten, tablo, view ve materialized view'lar
  `system.tables`'tan, kolonlar `system.columns`'tan okunur. Şema katmanı yoktur.
- **Sorgular**: Editördeki SQL `;` ile ifadelere bölünür. Satır döndüren ifadeler (`SELECT`, `WITH`,
  `SHOW`, `DESCRIBE`, `EXISTS`, `EXPLAIN`) akışla okunur ve satır limitinde kesilir; diğerleri
  `execute` ile çalışır. Tür, ifadenin baştaki anahtar kelimesinden anlaşılır; baştaki `--` yorumları atlanır.
- **Tablo sihirbazı**: `CREATE TABLE` üretir. Motor listesi: `MergeTree`, `ReplacingMergeTree`,
  `SummingMergeTree`, `AggregatingMergeTree`, `Log`, `Memory`. MergeTree ailesi için `ORDER BY`
  (sıralama anahtarı) zorunludur; boşsa primary key kolonları kullanılır. Nullable kolon `Nullable(T)`
  olur. `AUTO_INCREMENT` yoktur ve reddedilir.
- **Satır düzenleme yok**: Grid'den satır düzenleme reddedilir. Değişiklik için editörde
  `ALTER TABLE ... UPDATE` ya da `DELETE` yazılır.
- **Eylemler**: Inspect, View data (`LIMIT`/`OFFSET` ile sayfalama), Count rows ve Copy name.
  Rename, drop, truncate ve index eylemleri yoktur.
- **İptal**: Sunucu tarafı iptal yoktur (`supportsCancel: false`).
- **Test kapsamı**: Canlı testler ClickHouse 26.10'a karşı bağlantı, sorgu, sayfalama, listeleme, şema,
  DDL ve sihirbaz yolunu doğrular. Diğer sürümler ve masaüstü arayüzündeki tıklama akışı doğrulanmadı.

## Editör ve IntelliSense

SQL editörü (CodeMirror 6) bağlı olduğunuz veritabanının **şemasını bilir**.
(Yalnızca ilişkisel sürücülerde: `QueryLanguage::Sql` döndürmeyen motorlar — örn. Redis —
düz metin editörü kullanır, SQL anahtar kelimesi/şeması önermez.)

- **Tablo adları** — `SELECT * FROM ord…` yazarken tablolar önerilir.
- **Kolon adları ve tipleri** — `orders.` yazdığınızda kolonlar, yanlarında `decimal(12,2)`,
  `enum('new','paid','shipped')` gibi tipleriyle listelenir.
- **Nitelikli erişim** — hem `orders.id` hem `shop.orders.id` çalışır.
- **Anahtar kelimeler ve fonksiyonlar** — seçilen lehçeye (MySQL / PostgreSQL / SQLite) göre.
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
  biçimine sarıp planı ayrı bir tabloda gösterir. `supportsExplain` kapalı olan sürücülerde
  (Redis) düğme ve kısayol hiç sunulmaz; IPC katmanı da aynı çağrıyı reddeder.
- **Kayıtlı sorgular** — editördeki sorgu ad verilerek kaydedilir; `Saved queries` panelinden
  çalıştırılır, yeni sekmeye eklenir veya silinir. Sürücü/veritabanı ipucu saklanır ve uygun bir
  oturum açıksa sorgu o sürücüde çalıştırılır.

## Gezgin ağacı ve nesne grupları

Gezginde her veritabanı (PostgreSQL'de her şema) altındaki nesneler **türüne göre gruplanır** ve
her grup başlık + sayı ile gösterilir: **Tables, Views, Materialized views, Collections,
Keyspaces, Keys, Functions, Procedures, Triggers, Events, Sequences, Other**. Grup başlığına tıklayarak
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

Sekmeler sürücü tarafından bildirilir: `ObjectDetail.sections` içinde gelen bloklar (alan listesi,
tablo, kayıt listesi) arayüz tarafından genel olarak çizilir ve sürücü adı hiçbir yerde geçmez.
ClickHouse kendi **Storage** (MergeTree düzeni, partition tablosu ve satır başına optimize/drop
eylemleri, mutasyon günlüğü) ve **Query history** (`system.query_log`, istek üzerine yenilenen `live`
bölüm) sekmelerini bu yolla ekler. Bir eylem tıklandığında onay metni, yıkıcılık ve gerekiyorsa
yazılması gereken değer de sürücüden gelir; arayüz yalnızca sekmeyi ve satır değerini geri gönderir.

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
- Bağlantılar `driver_id`, `capabilities`, `dialect` ve `explain_statement` sorularını taşıdıkları
  sürücüden yanıtlar, ama teknik olarak bir adaptör yine de kendi cevabını yazabilir. Bunu `sqlite`
  için bir birim testi (gerçek bir `:memory:` bağlantısı), diğer motorlar için ise sürüklenme
  denetimi (bildirim üzerinden) korur.
- Sürüklenme denetimi sürücünün **bildirdiği sözleşmeyi** (`list_drivers` yükü: yetenekler, nesne
  türleri, eylemler, bağlantı alanları, ayrıca tanımlayıcı tırnak karakteri ve bir okumanın
  `EXPLAIN` ifadesi) kapsar. Sürücünün *döndürdüğü veri* (introspection satırları, örnek belgeler,
  plan satırları, `count_rows`) bu denetimin dışındadır; onları adaptör birim testleri ile `npm test`
  içindeki motor başına mock testleri doğrular. Mock `list_drivers` sırası da bilinçli olarak kayıt
  defterinden farklıdır (demo varsayılanı MySQL önce gelir) ve karşılaştırma kimliğe göre yapılır.
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
- Tarayıcı mock'u editör sonucunu motor başına biçimlendirir: Redis komutları `reply_to_table`
  eşlemesiyle (skaler → tek hücre, düz dizi → eleman başına satır, iç içe dizi → `col_1`/`col_2`,
  map → `field`/`value`), MongoDB `find`/`aggregate` örnek belgeleri `documents_table` eşlemesiyle
  (üst düzey alanların birleşimi, eksik alan `null`, extended JSON korunur) gösterilir.
  Yaklaşıklıklar: mock yalnızca örneklediği komutları yanıtlar — örneklenmeyen bir komut uydurma bir
  başarı yerine hata satırı döner; `aggregate` hattı değerlendirilmez ve koleksiyonun belgeleri olduğu
  gibi gösterilir; `count_rows` gerçek belge sayısını dönerken `find` örneklemi döner.
- **Redis**: Gezgin anahtarları `SCAN` ile **örnekler** (2 000 anahtar / 40 tur sınırı); tam
  keyspace listesi garanti edilmez. Oturum tek numaralı veritabanına sabittir ve `SELECT`
  desteklenmez. Yanıt→satır eşlemesi sezgiseldir (RESP2 `HGETALL` gibi düz diziler tek kolonlu
  N satır olarak görünür; RESP3 map ise `field`/`value` tablosu). İptal yoktur
  (`supports_cancel: false`) ve TLS `Preferred` bir geri düşüş yapmaz.
- `Require WHERE on UPDATE/DELETE` denetimi ifadeyi basit bir anahtar kelime taramasıyla inceler;
  tırnak/yorum içindeki `WHERE` kelimesi de eşleşebilir (kaba ama güvenli tarafta bir denetim).
- Ek nesne keşfi sorguları (trigger/routine/event/sequence) canlı bir sunucu olmadan yalnızca SQL
  düzeyinde ve ortak sınıflandırma birim testiyle doğrulanır; yetki kısıtları sunucuda sorguyu
  sınırlayabilir (satırlar filtrelenir, hata döndürmez).
- **Trigger / prosedür gövdeleri**: `sql_split`, `CREATE TRIGGER|PROCEDURE|FUNCTION|EVENT` ifadelerindeki `BEGIN ... END` ve `CASE ... END` bloklarını izler; gövdedeki `;` ifadeyi bölmez. `IF ... END IF`, `LOOP`, `WHILE`, `REPEAT` gibi MySQL kontrol akışı da desteklenir. Bu, bloklar ayrıştırıcı tarafından izlendiği için tek bir script içinde de çalışır.
- SQLite'ta `ALTER COLUMN` yalnızca kolonu yeniden adlandırır; tip/kısıt değişimi için tabloyu
  yeniden oluşturmak gerekir (arayüz bunu açıkça reddeder).
- SQLite `supportsMultipleDatabases: false` ve `supportsCancel: false` döner; `ALTER COLUMN`,
  `VACUUM` ve index türü gibi farklar diyalogların canlı SQL önizlemesinde de yansıtılır
  (`src/lib/objects.ts` içindeki `dialectForDriver`).
- ERD görselleştirme hâlâ yol haritasında.
- Tamamlama ağacına en fazla 400 tablo beslenir; çok büyük şemalarda kalan tablolar
  atlanır (editör yanıt vermeye devam eder).

## Yardımcı scriptler

| Komut | Ne yapar |
| --- | --- |
| `npm test` | Node'un yerleşik test koşucusuyla `src/lib` yardımcılarını doğrular: ayar kaydı, şema farkı, satır düzenleme kabuğu, gezgin ağacı, inspector bölüm yükleme sırası, Redis/Mongo yanıt→tablo eşlemesi, motor başına mock fikstürlerinin adaptörlerle tutarlılığı ve mock fikstürlerinin Rust sürücü bildirimlerine karşı sürüklenme denetimi |
| `npm run check:drift` | Sürüklenme denetimini iki yarıyıyla koşar: Rust kayıt defteri ↔ `src/lib/fixtures/driver-descriptors.json` ↔ `src/lib/mockFixtures.ts` (yetenekler, alanlar + tırnak karakteri ve `EXPLAIN` yanıtı) |
| `npm run icon` | İkonu çizer (`scripts/generate-icon.mjs`) ve tüm platform boyutlarını (`icns`, `ico`, Android/iOS) üretir |
| `npm run preview:html` | Uygulamayı tek dosyalık `preview.html` olarak paketler (tarayıcıda incelemek için) |
| `node scripts/build-icon-sheet.mjs` | İkonu 512/256/128/64/32 px boyutlarında açık ve koyu zeminde gösteren `icon-sheet.html` üretir |

İkon `scripts/generate-icon.mjs` içinde **kod olarak** tanımlıdır: harici görsel dosya ya da
bağımlılık yok, sadece Node'un `zlib`'i ile PNG üretilir. Rengi değiştirmek için dosyadaki
`PALETTE` dizisini düzenleyip `npm run icon` çalıştırmak yeterlidir.
