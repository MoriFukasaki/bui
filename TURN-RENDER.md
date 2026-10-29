# Kết nối đủ camera khi máy dùng Wi-Fi khác nhau / 4G / 5G

Neon lưu video và dữ liệu; Render giữ phòng/signaling. Cả hai không tự cung cấp TURN cho kết nối media giữa các điện thoại. STUN-only có thể kết nối được một vài cặp nhưng thất bại ở các cặp khác do NAT/firewall. Cần dịch vụ TURN thật.

## Tạo credential (ví dụ Metered)

1. Vào https://dashboard.metered.ca/ và đăng ký/đăng nhập. Tạo workspace nếu được yêu cầu.
2. Chọn TURN Server → Credentials → Create Credential. Đặt label `camroom-test`.
3. Trong credential vừa tạo, chọn Get credential → Show ICE Servers Array. Dashboard cũ có thể dùng nút Add Credential / Show ICE Servers Array.
4. Lấy các URL bắt đầu `turn:` hoặc `turns:`, username và credential (password). Dùng đúng endpoint được cấp cho gói/region của bạn, không đoán hoặc lấy endpoint từ workspace khác. Không dùng Developer Secret Key làm password.
5. Chờ tối đa khoảng 2 phút để credential mới lan truyền. Kiểm tra quota/băng thông của gói trước khi test nhiều camera. Không bật mua thêm tự động nếu bạn chưa muốn chi phí phát sinh.

Tài liệu chính thức: https://www.metered.ca/docs/turn-server-service/creating-turn-credentials/

## Điền trên Render sau khi bản sửa được deploy

Mở Web Service Camroom → Environment → thêm các biến:

```dotenv
TURN_URLS=turn:ENDPOINT_DASHBOARD_CAP:80,turn:ENDPOINT_DASHBOARD_CAP:80?transport=tcp,turns:ENDPOINT_DASHBOARD_CAP:443?transport=tcp
TURN_USERNAME=
TURN_PASSWORD=
ICE_TRANSPORT_POLICY=relay
```

Thay toàn bộ các URL bằng đúng URL dashboard của bạn cung cấp, ngăn cách dấu phẩy trên một dòng. Điền username/password vào giao diện Render, không vào GitHub/chat. Không thêm dòng `stun:` vào TURN_URLS; app đã có STUN mặc định. Xóa/để trống `TURN_SECRET` khi dùng username/password. `TURN_SECRET` chỉ dành cho coturn dùng HMAC shared-secret, không phải developer secret của dịch vụ relay.

Save and deploy. Log khởi động phải có `Camera relay: configured (relay)`. Nếu báo thiếu hoặc xung đột credential, kiểm tra tên biến và bảo đảm chỉ chọn một kiểu xác thực.

`relay` ép truyền hình qua TURN để xác minh relay thực sự hoạt động. Sau khi test thành công có thể đổi `ICE_TRANSPORT_POLICY=all`, redeploy và tạo phòng mới: app ưu tiên đường trực tiếp, khi lỗi thử lại qua TURN. Cấu hình có credential không đồng nghĩa credential hợp lệ/đủ quota; phải test thực tế.

## Test lại

1. Sau deploy, tất cả máy đóng tab web cũ rồi mở lại link Render. Tạo phòng mới, không trộn client cũ và mới trong cùng phòng.
2. Laptop dùng Wi-Fi, điện thoại dùng 4G/5G. Bắt đầu với 2 máy, rồi 3–4 máy.
3. Kiểm tra dòng `Đang xem X/Y camera khác` trên từng máy: X phải bằng Y; camera của chính máy đó không tính vào Y. Máy chỉ xem cũng tính vào giới hạn tổng 10 thiết bị.
4. Nếu có nút Hiện hình, chạm để trình duyệt cho phép phát. Nếu một ô lỗi, dùng Kết nối lại ở chính ô đó. Không cần tắt camera gốc/đang ghi.
5. Test điện thoại tắt Wi-Fi để chuyển sang dữ liệu di động, rồi bật lại. Các cặp kết nối có tự thử lại; không cần rời phòng nếu signaling vẫn còn. Nếu mất cả server/signaling, giao diện yêu cầu vào lại phòng.
6. Test quay 15–30 giây sau khi nhận đủ hình, dừng và kiểm tra đủ file Neon. Sửa đường xem trước không thay việc ghi video riêng từ camera gốc.

Nếu `relay` không cho bất kỳ máy nào nhận hình: kiểm tra credential đã active, endpoint đúng gói, quota còn và có URL TCP/TLS 443 do nhà cung cấp cấp. Nếu chỉ một cặp lỗi, giữ thông báo lỗi ở ô đó và kiểm tra máy/browser/mạng thực tế. Không gửi ảnh có password vào chat.

## Thay đổi trong bản sửa

- Mỗi chiều camera có connectionId riêng; candidate/answer của lượt kết nối cũ không phá lượt mới.
- Đàm phán từng cặp độc lập, một cặp lỗi không bỏ qua các camera còn lại.
- Tự thử lại kết nối lỗi, có TURN thì thử relay; nút kết nối lại từng camera và phục hồi sau online.
- Áp dụng bitrate/scale preview sau đàm phán. Browser không hỗ trợ chỉnh RTP parameters vẫn giữ kết nối hợp lệ.
- Hiển thị số camera nhận được, cảnh báo thiếu TURN và nút phát thủ công khi mobile chặn autoplay.

Test tự động dùng WebRTC giả lập để kiểm tra đủ 90 chiều của 10 camera, ICE đến trước SDP, lỗi một cặp, retry, bỏ tín hiệu cũ và các kiểu TURN config. Test này không thay thế xác minh TURN thật qua mạng di động.
