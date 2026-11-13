# Lặng

Âm thanh nền tự sinh để tập trung và ngủ, chạy hoàn toàn trên trình duyệt.

- **Focus**: nhịp nhẹ và sáng, cho việc thường ngày.
- **Deep Focus**: trầm, đều, ít biến động.
- **Sleep**: chậm, ấm, lắng dần; có hẹn giờ tự tắt.

Mỗi lần phát là một bản mới. Nhạc được sinh bằng Web Audio (`OfflineAudioContext`) thành từng đoạn WAV rồi phát qua thẻ `<audio>`, nên vẫn chạy khi khoá màn hình điện thoại. Không dùng mẫu âm thanh hay thư viện ngoài.

## Dùng trên iPhone

Mở trang bằng Safari, bấm Chia sẻ → "Thêm vào Màn hình chính". Sau lần mở đầu tiên app chạy được khi không có mạng.

## Chạy trên máy

```bash
python -m http.server 8765
```

rồi mở http://localhost:8765.

## Cấu trúc

- `engine.js`: sinh nhạc và render thành WAV.
- `app.js`: phát, nối đoạn, hẹn giờ, giao diện.
- `sw.js`, `manifest.webmanifest`, `icons/`: phần cài đặt và chạy offline.
