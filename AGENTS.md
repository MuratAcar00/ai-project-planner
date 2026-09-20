# Repository Guidelines

## Amaç ve Kapsam

Bu repository, bir fikri gereksinimlerden çalışan yazılıma kadar mümkün olduğunca otomatik ilerleten bir AI Software Development Agent sistemidir. Tüm çalışma yalnızca bu repository içinde yapılır. Kullanıcı açıkça istemedikçe repository dışındaki dosyalar değiştirilmez; `sudo` kullanılmaz.

## Göreve Başlama ve Planlama

Her görevden önce repository durumunu (`git status`), ilgili kaynak dosyaları, testleri ve mevcut yapılandırmayı incele. Küçük olmayan değişikliklerde önce kısa bir uygulama planı oluştur; kapsam, etkilenen dosyalar, doğrulama yaklaşımı ve riskleri belirt. Kullanıcı yalnızca bir fikir verdiyse, önce net gereksinimleri, varsayımları ve kabul ölçütlerini çıkar; sonra uygulanabilir bir proje planı sun.

## Mimari ve Teknoloji Tercihleri

Varsayılan teknoloji Node.js ve JavaScript'tir. Bu uygulamada Express sunucusu `src/` altında, framework-free istemci `public/` altında, API entegrasyon testleri `test/` altında bulunur. `src/app.js` rotaları, `validation.js` girdileri, `planner.js` plan üretimini ve `store.js` JSON kalıcılığını yönetir. Gereksinim gerektirdiğinde uygun framework seçilebilir; basit işler için gereksiz framework veya dependency ekleme. Modern, sürdürülebilir ve modüler çözümleri tercih et.

## Kod Kalitesi ve Güvenlik

Mevcut JavaScript stilini izle: iki boşluk girinti, tek tırnak, noktalı virgül, `camelCase` değişken/fonksiyon adları ve `PascalCase` sınıf adları. Mevcut çalışan davranışı gereksizce bozma. Production kalitesini hedefle: doğrulama, anlamlı hata yanıtları, güvenli varsayılanlar, sınırlandırılmış girdi, test edilebilirlik, bakım kolaylığı ve dokümantasyonu değerlendir.

Secret, API anahtarı, token veya parolayı kaynak koda yazma. `.env`, secret dosyaları ve çalışma verileri (ör. `data/projects.json`) Git'e eklenmez. Dış sisteme kalıcı değişiklik, ücret doğuran işlem veya geri döndürmesi zor eylem gerçekleştirmeden önce kullanıcı onayı al.

## Doğrulama ve Testler

JavaScript/Node.js değişikliklerinden sonra uygun testleri çalıştır. Bu projede temel komutlar şunlardır:

```bash
npm install       # bağımlılıkları kurar
npm start         # uygulamayı localhost:3000 üzerinde çalıştırır
npm run dev       # izleme modunda geliştirme sunucusunu başlatır
npm test          # Node'un yerleşik test çalıştırıcısını kullanır
```

Yeni davranış için `test/` altında `node:test` ve `node:assert/strict` ile başarı ve hata senaryolarını kapsayan testler ekle. Testler geçici veri dosyası kullanmalı, gerçek `data/projects.json` dosyasını değiştirmemelidir. Test, lint veya build başarısız olursa terminal çıktısını dikkatle incele, sebebi araştır, düzelt ve doğrulamayı tekrar çalıştır. Yapılandırılmış lint/build komutu varsa, ilgili kod değişikliğinden sonra bunları da çalıştır.

## Değişiklik, Git ve Teslim

Destructive işlemleri kullanıcı onayı olmadan yapma. `git commit`, `git push`, GitHub işlemleri ve deployment kullanıcı açıkça istemedikçe yapılmaz; kullanıcı bu süreçlerin kontrolünü korur. Commit gerektiğinde kısa, emir kipinde Conventional Commit tarzı kullan (`feat: ...`, `fix: ...`).

Her tamamlanan görevde değiştirilen dosyaları, çalıştırılan doğrulamaları ve varsa kalan sorunları net biçimde özetle.
