# Tài khoản quản trị video trên Render

Trang `/admin` dành cho một tài khoản quản trị do bạn cấu hình. Không có tài khoản/mật khẩu mặc định, không mở đăng ký. Admin xem video của mọi phòng (kể cả phòng đã đóng), lọc theo phòng/trạng thái, xem lỗi và tải file gốc. Danh sách lấy từ Postgres, không phụ thuộc phòng còn trong RAM. Trang này không xóa video.

1. Trên máy của bạn, mở terminal trong thư mục mã nguồn, chạy `npm run admin:password`.
2. Nhập mật khẩu riêng tối thiểu 12 ký tự rồi Enter. Lúc nhập sẽ không hiện ký tự. Lệnh chỉ in **hash scrypt**, không in mật khẩu.
3. Vào Render → Camroom → Environment → Add Environment Variable:

   | Key | Value |
   | --- | --- |
   | `ADMIN_USERNAME` | Tên đăng nhập bạn tự chọn, ví dụ `mori` |
   | `ADMIN_PASSWORD_HASH` | Toàn bộ chuỗi bắt đầu bằng `scrypt:` do lệnh trên tạo ra |
   | `NODE_ENV` | `production` |

   Với hash, chỉ copy phần **sau** `ADMIN_PASSWORD_HASH=`. Không thêm dấu nháy. Không gửi mật khẩu/hash vào chat hoặc commit chúng vào GitHub.
4. Save, rebuild, deploy. Mở **link HTTPS của app + `/admin`** (hoặc bấm Quản trị video ở đầu trang). Đăng nhập bằng tên đã chọn và **mật khẩu gốc**, không phải hash.
5. Bấm Lọc / Làm mới để lấy trạng thái mới. Bấm Tải video gốc. Link tải hết hạn sau 5 phút; bấm nút lần nữa để lấy link mới.

Đổi mật khẩu: chạy lại lệnh, thay hash trong Render rồi deploy. Phiên đăng nhập hết hạn sau 8 giờ, bị hủy khi server khởi động lại/đăng xuất. Cookie HttpOnly, SameSite=Strict, Secure trong production; các thao tác admin yêu cầu CSRF token. Đăng nhập sai bị giới hạn 10 lần/15 phút theo kết nối server (Render proxy có thể dùng chung giới hạn này cho nhiều người). Đây là tài khoản quản trị đơn cho một instance; không phải hệ thống đăng ký nhiều người dùng.

## Kiểm tra chất lượng và điện thoại lỗi lưu

1. Sau khi deploy, tải lại trang trên **tất cả** máy để nhận mã mới, tạo phòng mới. Ghi mặc định yêu cầu 1920×1080, 30 fps, 10 Mbps; số lượng máy chỉ làm giảm bản xem trước. Thiết bị có thể chọn chế độ thấp hơn nếu không hỗ trợ; xem dòng **Thực tế** trong cấu hình và thông số ở danh sách video.
2. Muốn buộc 1080p: chọn đúng máy → 1080p → 30 fps → 10 hoặc 20 Mbps → Áp dụng. Nếu máy không hỗ trợ, app báo lỗi; kiểm tra dòng Thực tế trước khi bấm Sẵn sàng. Bitrate encoder do trình duyệt chọn có thể khác yêu cầu. Web ghi trực tiếp từ camera, server không nén hay resize file tải về.
3. Bấm Sẵn sàng trên từng máy, quay thử 10–15 giây rồi Dừng tất cả. Giữ trang mở, màn hình sáng. Xác nhận **tất cả** video báo Đã lưu Neon trước khi thoát.
4. Mở file tải về, xem Properties/Details hoặc MediaInfo để kiểm tra kích thước khung hình. Thông số trong app là thông số camera/encoder báo, file thực tế là phép kiểm tra cuối cùng. Video cũ quay 480p/720p không thể khôi phục chi tiết 1080p.
5. Nếu bộ nhớ điện thoại lỗi, app dùng RAM dự phòng tối đa 64 MB và giải phóng các đoạn sau khi server xác nhận nhận. Cần giữ trang mở; RAM không sống qua reload/đóng tab. Khi mạng quá chậm làm đầy RAM, app dừng và báo lỗi thay vì tiếp tục quay mất dữ liệu. Bản dự phòng không có đủ đoạn trên máy thì chỉ tải bản hoàn tất trên Neon.
6. Lỗi giờ kèm tên và nội dung lỗi gốc. Nếu còn lỗi, gửi dòng lỗi và model điện thoại/trình duyệt, không gửi credential. Video lỗi từ bản cũ: thử Tải bản trên máy ở chính điện thoại quay; không bảo đảm phục hồi nếu phần cuối đã mất.

Render free có đĩa tạm: server nhận chunk chưa đồng nghĩa video đã lưu Neon. Không deploy/restart trong lúc ghi/upload. Dùng persistent disk cho spool nếu cần giữ đoạn chưa hoàn tất qua restart.
