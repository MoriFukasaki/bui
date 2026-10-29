# Chủ phòng là admin, chỉ giữ lượt quay mới nhất

Không cần tài khoản admin riêng hoặc biến ADMIN_USERNAME / ADMIN_PASSWORD_HASH. Người **tạo phòng** là admin của chính phòng đó, dùng được cả vai trò Chỉ xem hoặc Phát camera. Các biến admin cũ có thể bỏ khỏi Render. Trang /admin và quyền truy cập video của mọi phòng đã được gỡ.

- Chỉ admin có nút và quyền API **tải / xóa** video. Thành viên xem hình và trạng thái, camera gửi video lên nhưng không có nút tải bản tạm.
- Admin bấm **Quay lượt mới (xóa lượt cũ)**: server xóa video, sidecar và bản spool của các lượt cũ **trong cùng phòng**, xóa metadata tương ứng; sau đó mới tạo lượt mới và đếm ngược. Không đụng phòng khác. Không có bước đợi quay xong lượt mới rồi mới xóa lượt cũ.
- Xóa là vĩnh viễn. Tải các video muốn giữ trước khi bấm quay tiếp. Nếu xóa cũ thất bại, server không bắt đầu ghi lượt mới; các file đã xóa thành công trước lỗi không thể rollback. Thử lại để dọn nốt.
- Nút Xóa video cho phép xóa từng clip khi đã dừng quay. Bấm lần đầu hiện xác nhận ngay trên nút, bấm lần nữa để xóa.
- Upload cũ bị vô hiệu hóa; camera gửi trễ không thể tạo lại video đã xóa. Thiết bị đang online dọn bản tạm ngay; thiết bị offline dọn khi vào lại phòng/nhận trạng thái xóa. Lỗi bộ nhớ có thể khiến dọn dữ liệu cục bộ chưa hoàn tất; server vẫn từ chối quyền upload/tải.

## Quyền chủ phòng và tải lại trang

Quyền admin được lưu bằng cookie riêng của phòng (HttpOnly, SameSite=Strict, Secure trên production), chỉ lưu hash trong Postgres. Mã/link mời không chứa quyền admin. Chủ phòng mất kết nối **không** làm người khác lên admin.

Tải lại trang, nhập lại tên và tham gia **đúng mã phòng trên cùng trình duyệt** để khôi phục quyền. Có thể chọn Chỉ xem nếu không muốn bật camera. Sau server restart, admin có thể mở lại phòng từ metadata trong Neon. Cookie có hạn 30 ngày; không xóa cookie/dùng trình duyệt ẩn danh nếu cần giữ quyền. Không tự nhận lại chủ phòng bằng mã mời khi mất cookie.

Mỗi lượt xem trước vẫn dùng WebRTC; tải file qua server kiểm tra cookie admin mỗi lần, không gửi URL S3 dùng chung cho các máy. Bản đã tải về trước khi xóa không thể thu hồi. Chủ thiết bị camera vẫn kiểm soát phần cứng và dữ liệu trên máy của họ; đây là phân quyền ứng dụng, không phải DRM.

## Deploy và test

1. Deploy commit mới trên Render. `npm start` tự chạy migrations idempotent 001 và 002 trước khi mở server; dùng DATABASE_URL_UNPOOLED khi có. Không cần thêm biến admin.
2. Tạo **phòng mới** sau deploy, dùng máy tạo phòng làm admin; vào bằng điện thoại khác để thử. Video/phòng tạo trước phiên bản này không được tự gán admin hoặc xóa hàng loạt.
3. Mặc định ghi yêu cầu 1080p / 30 fps / 10 Mbps; xem dòng Thực tế để kiểm tra máy có đáp ứng. Bản xem trước giảm chất lượng độc lập.
4. Tất cả máy bấm Sẵn sàng, admin quay 10–15 giây rồi dừng. Chờ mọi clip báo Đã lưu Neon; chỉ admin có nút tải/xóa.
5. Tải lại trang admin, tham gia đúng phòng trên cùng trình duyệt và xác nhận còn quyền. Thành viên không được kế thừa quyền khi admin thoát.
6. Bấm quay lượt tiếp: các clip cũ biến mất; chỉ xuất hiện clip của lượt mới. Link tải cũ và upload cũ phải bị từ chối. Phòng khác không đổi.
7. Thử Xóa video trên một clip đã dừng, xác nhận clip biến mất trên tất cả máy.

Render free có đĩa tạm: không restart/deploy giữa lượt ghi/upload. RAM dự phòng trên điện thoại tối đa 64 MB cho các đoạn chưa được server nhận; giữ trang mở đến khi upload xong. Thông tin phòng/quyền admin và video đã lưu ở Neon sống qua restart; spool chưa hoàn tất cần persistent disk để sống qua restart.
