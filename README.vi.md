# ☕ lovechat — Không gian riêng dành cho hai người

Ứng dụng trò chuyện thời gian thực dành cho hai người, hỗ trợ tin nhắn văn bản, tin nhắn thoại, hình ảnh, tệp, cuộc gọi thoại WebRTC, khoảnh khắc và ảnh đại diện.

## Chạy cục bộ

```bash
npm install
npm start
```

Mặc định, dịch vụ chạy tại `http://localhost:8100`.

## Kiểm thử

Khởi động máy chủ trước, sau đó chạy trong một cửa sổ terminal khác:

```bash
npm test
```

Bộ kiểm thử bao gồm kết nối hai người dùng, lịch sử tin nhắn, mật khẩu phòng, hình ảnh, tệp, tin nhắn thoại, tín hiệu WebRTC, khoảnh khắc, ảnh đại diện và tên phòng có dấu tiếng Việt.

## Triển khai Linux

Xem hướng dẫn và tệp dịch vụ tại thư mục `deploy/`. Cổng có thể được thay đổi bằng biến môi trường `PORT`; dữ liệu được lưu tại đường dẫn trong biến `DATA_FILE`.

## Phiên bản tiếng Việt

- Toàn bộ giao diện và thông báo dành cho người dùng đã được dịch sang tiếng Việt.
- Tên phòng hỗ trợ chữ cái tiếng Việt có dấu.
- Mã nhận dạng phòng cũ chỉ gồm chữ Latin, số, `_` và `-` vẫn hoạt động bình thường.
