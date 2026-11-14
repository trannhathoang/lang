# Lặng

Âm thanh nền tự sinh để tập trung và ngủ, chạy hoàn toàn trên trình duyệt.

- **Focus**: hợp âm ngân trầm và ấm, nhịp đập đều mỗi giây. Có Pomodoro: chọn số phút tập trung, số phút nghỉ và số vòng; chuông báo mỗi lần đổi pha.
- **Deep Focus**: trầm, đều, ít biến động.
- **Study**: nhịp lo-fi chậm với phím đàn ấm; cho lúc đọc và học. Cũng dùng được Pomodoro.
- **Solfeggio**: chỉ một âm sin thuần, giữ đều, ở tần số tự chọn (174, 285, 396, 417, 528, 639, 741, 852 hoặc 963 Hz).
- **Sleep**: mở đầu bằng một câu chuông chậm lặp lại trong khoảng một phút rưỡi, nền là một hợp âm đứng yên với tiếng ồn trầm, trầm và nhỏ dần theo thời gian; khoảng phút thứ 15 có tiếng sóng khẽ hoặc mưa; có hẹn giờ tự tắt.

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
