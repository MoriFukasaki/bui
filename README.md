# Camroom — quay nhiều máy, mỗi máy một video

## Trước khi push GitHub

Chạy `npm run check:publish`, `npm run check:publish:test`, `npm test`, `npm run build` và `npm audit`. Sau `git add .`, chạy lại `npm run check:publish` để quét cả nội dung đã stage. Không force-add các file đang bị ignore: `.env.local`, `.neon`, `data/`, `verification/`, video, ZIP và bản build. Đọc [SECURITY.md](SECURITY.md) về mô hình truy cập và các giới hạn khi mở web ra Internet. GitHub Actions đã có workflow kiểm tra không dùng khóa production; Dependabot kiểm tra dependency và Action mỗi tuần.

Tạo phòng chọn 1–10 camera; tối đa 10 thiết bị tính cả máy chỉ xem. Mỗi máy xem các góc còn lại qua WebRTC. Chủ phòng bấm **Bắt đầu quay tất cả / Dừng tất cả**, mỗi camera tạo **một video riêng**, cùng mã lượt quay. Có cấu hình từng camera, thu micro tùy chọn và upload vào Neon.

## Chạy ứng dụng

Node.js 24 trở lên:

```sh
npm ci
npm run build
npm run db:migrate
npm start
```

Mở http://localhost:3000 trên chính máy chạy server. Điện thoại cần **HTTPS**; HTTP qua IP LAN không được cấp quyền camera. Source chạy bằng `npm start`; bản đóng gói nằm trong `dist/`. Test offline: `npm test`.

Server đọc `.env`, sau đó `.env.local`; biến do nền tảng host cung cấp được ưu tiên cao nhất. Không commit env chứa secret, không đưa vào public hoặc ZIP source.

## Neon đã thiết lập

- Org: `org-raspy-king-04696414`.
- Project: `still-bonus-09478698` (Web cam), region Singapore `aws-ap-southeast-1`.
- Nhánh: `production` (`br-bold-truth-aod2t6qh`).
- **Object Storage:** bucket `assets`, private. Mỗi video ở `camroom/<phòng>/<lượt>/cam-<slot>-<id>.mp4` hoặc `.webm`, kèm JSON timing/cấu hình.
- **Postgres:** bảng `camroom_recordings` lưu trạng thái, mã lượt, camera, object key, dung lượng và metadata. Không lưu bytes video hoặc upload token trong database.
- **Realtime:** server đăng ký live query trạng thái video của từng phòng, chuyển tiếp cập nhật xuống các máy. Room signaling/điều khiển vẫn dùng SSE của Node.js.

`neon deploy` đã kéo các biến sau vào `.env.local`:

```dotenv
DATABASE_URL=...
DATABASE_URL_UNPOOLED=...
AWS_ENDPOINT_URL_S3=...
AWS_REGION=...
AWS_ACCESS_KEY_ID=...
AWS_SECRET_ACCESS_KEY=...
NEON_REALTIME_URL=...
NEON_REALTIME_SECRET=...
```

`NEON_BUCKET` mặc định `assets`. `RECORDING_DIR` mặc định `./data/recordings`, cần đĩa bền vững đủ dung lượng. `MAX_RECORDING_BYTES` mặc định 2147483648 (2 GiB/video).

Driver `pg` dùng pool cho Node server chạy lâu dài; migration dùng URL unpooled. TLS xác minh chứng chỉ đầy đủ. S3 dùng AWS SDK, SigV4, path-style. Realtime SDK chạy ở server; các secret đều ở backend. Link tải video private có hạn 5 phút.

Cài lại trên máy khác, giữ file `neon.ts` và đúng project/nhánh:

```sh
npm i -g neon@latest
neon login
neon init -y --org-id org-raspy-king-04696414 --project-id still-bonus-09478698 --branch production --services "postgres,object-storage,realtime"
neon deploy
npm run db:migrate
```

Nếu cài global CLI không được, dùng `npx neon@latest` thay `neon`. Hoàn tất đăng nhập khi CLI mở trình duyệt. Nếu dịch vụ đã được triển khai và chỉ cần kéo biến, dùng `neon env pull`.

Muốn tạo bucket trong project mới: link đúng project/nhánh, khai báo `buckets: { assets: { access: "private" } }` trong `neon.ts`, rồi `neon deploy`. Không đặt video thành public. [Neon Storage quickstart](https://neon.com/docs/storage/get-started), [S3 compatibility](https://neon.com/docs/storage/s3-compatibility).

## Cách quay

1. Người điều phối tạo phòng, chọn số camera. Người tạo là chủ phòng; có thể dùng chế độ Chỉ xem. Ví dụ 9 camera + 1 màn hình điều phối, hoặc 10 camera và điều phối ngay trên một máy quay.
2. Sao chép link cho từng điện thoại. Đặt tên rõ ràng, chọn Phát camera, cấp quyền.
3. Mở **Cấu hình camera & chất lượng ghi**. Chủ phòng chọn từng máy để chỉnh từ xa; mỗi camera cũng tự chỉnh được. Có độ phân giải, fps, bitrate file ghi, bitrate xem trước và bật/tắt thu micro.
4. Zoom, lấy nét, phơi sáng, ISO, cân bằng trắng, nhiệt độ màu, độ sáng, tương phản, bão hòa, độ nét và đèn chỉ xuất hiện nếu thiết bị báo hỗ trợ qua `getCapabilities()`. Web không điều khiển được mọi chức năng của app camera gốc. Giao diện hiển thị độ phân giải/fps thực tế sau áp dụng; tổ hợp không hỗ trợ sẽ báo lỗi. Camera trước/sau đổi tại điện thoại đó.
5. Trên **mỗi điện thoại**, bấm **Sẵn sàng quay trên máy này**. Khi bật thu micro, thao tác này xin quyền micro tại máy đó. Âm thanh chỉ vào file, không phát trong ô xem trước để tránh hú. Sau đổi cấu hình, bấm sẵn sàng lại.
6. Khi tất cả camera sẵn sàng, chủ phòng bấm **Quay lượt mới (xóa lượt cũ)**. Đếm ngược chung khoảng 3 giây. Máy vào sau khi lượt đã bắt đầu sẽ tham gia từ lượt kế tiếp.
7. Bấm **Dừng tất cả**: mỗi máy chốt file gốc rồi tự upload. Có thể chọn **Tạm hoãn upload (đợi mạng tốt)** trong Video trên thiết bị này. Giữ trang mở, chờ mọi video báo **Đã lưu Neon** mới quay lượt tiếp; chỉ admin có nút tải/xóa. Nếu mất mạng phòng khi đang ghi, máy tiếp tục ghi và có nút **Dừng máy này & lưu video**.

Chỉ chủ phòng được quay/dừng chung và chỉnh camera khác. Chủ phòng là admin và không tự chuyển quyền khi rời phòng. Chỉ admin được tải/xóa; phòng chỉ giữ lượt quay mới nhất, chỉ xóa lượt cũ khi tất cả video đã upload (hoặc admin đã chủ động xóa video muốn bỏ). Người có mã/link có thể vào và xem hình; chỉ chia sẻ trong nhóm. Lên hình là tín hiệu phối hợp, không quyết định máy được ghi: mọi camera sẵn sàng đều quay riêng.

## Lưu và khôi phục video

MediaRecorder chọn MP4 hoặc WebM tùy trình duyệt. File ghi lấy từ track camera gốc, không lấy ô xem trước đã truyền qua mạng. Bitrate ghi và bitrate xem trước riêng biệt, nhưng tăng độ phân giải ghi vẫn tăng tải capture/encode của điện thoại.

Trong khi ghi, dữ liệu chỉ được lưu dần vào IndexedDB của điện thoại, không upload video. Sau khi dừng và ghi xong đoạn cuối, dữ liệu mới truyền thành các chunk tối đa 2 MiB tới đĩa server. Chunks có thứ tự, retry idempotent và nối nguyên byte thành **một file mỗi camera**. Sau khi dừng, server nhận đủ dữ liệu rồi upload multipart lên Neon, cập nhật Postgres. JSON sidecar chứa cấu hình, timestamp gốc thiết bị, offset ước lượng và timestamp quy đổi theo đồng hồ server.

**Không bảo đảm đồng bộ từng frame, timecode phần cứng hoặc thời lượng file giống nhau tuyệt đối.** Mạng, camera và hệ điều hành có thể gây trễ/mất frame. Dùng clap/tiếng vỗ tay đầu lượt nếu cần ghép hậu kỳ chính xác.

Nếu upload lỗi, bản điện thoại và spool server vẫn được giữ. Trong **Video trên thiết bị này**, chọn **Thử tải lên Neon** (tắt tạm hoãn upload trước nếu đang bật). Upload token riêng từng file cho phép thử tiếp sau khi rời phòng/server restart, miễn đĩa server còn dữ liệu. Không xóa dữ liệu trình duyệt hoặc đổi origin trước khi có bản sao. Nếu tab/OS bị đóng giữa lúc ghi, bản partial có thể không phát được; không bảo đảm lấy lại phần browser chưa xuất ra.

Spool và IndexedDB chưa tự dọn để giữ khả năng khôi phục. Theo dõi dung lượng điện thoại/VPS; sao lưu xác nhận rồi dọn theo chính sách của bạn. Sau khi phòng đóng, metadata/video vẫn còn trên Neon; giao diện hiện tập trung vào phòng đang hoạt động, chưa có thư viện tài khoản để duyệt mọi phòng cũ.

## Tự host HTTPS bằng Docker

Neon đã triển khai backend dữ liệu; web Node.js vẫn cần VPS/hosting chạy lâu dài. Không đưa riêng public lên static hosting. Chạy một instance: room/presence trong RAM, restart ngắt kết nối đang mở; admin dùng lại đúng trình duyệt và mã phòng để khôi phục quyền từ Neon.

1. Trỏ DNS domain về VPS; cài Docker + Compose; mở TCP 80/443.
2. Copy source và `.env.local` chứa biến Neon lên server bằng kênh riêng tư, không đưa secrets vào image/public.
3. Tạo `.env` với `DOMAIN=cam.example.com`, không có `https://`. Có thể thêm TURN.
4. Chạy migration với môi trường có `.env.local` nếu chưa có bảng; bảng production hiện đã được tạo.
5. Chạy `docker compose up -d --build`, mở `https://cam.example.com`. Caddy tự cấp HTTPS. Volume `recording_data` giữ spool qua restart.

Reverse proxy khác cần tắt buffering `/api/events`, giữ Host đúng, không cache API và cho phép upload dài. Luồng upload: điện thoại → VPS → Neon; VPS cần đủ băng thông và đĩa. Compose dựng app + HTTPS, chưa dựng TURN.

## Mạng và giới hạn thiết bị

Nếu các máy chỉ thấy một vài camera, đọc [hướng dẫn TURN trên Render](TURN-RENDER.md). Bản mới có tự khôi phục từng cặp, nút Kết nối lại và hỗ trợ `TURN_USERNAME`/`TURN_PASSWORD` của dịch vụ relay. Khi test khác Wi-Fi/4G/5G, cấu hình TURN thật và dùng `ICE_TRANSPORT_POLICY=relay` để xác minh trước khi đổi về `all`.

WebRTC mesh gửi riêng tới từng thiết bị còn lại: 10 máy có thể có 90 luồng video một chiều. Tối ưu mặc định cho 3 camera: preview 3 FPS, chiều dài tối đa 480 px, 100 Kbps mỗi bên nhận; chỉnh được 2/3/5 FPS và 50–150 Kbps. Ba camera gửi cho nhau cần khoảng 200 Kbps upload/máy cộng overhead. Bản ghi vẫn yêu cầu 1080p/30 FPS/10 Mbps; không giảm track ghi để hạ preview. Giới hạn RTP tùy hỗ trợ trình duyệt, không bảo đảm đúng FPS/bitrate trên mọi máy. Upload file gốc chỉ bắt đầu sau khi dừng. Không bảo đảm mọi điện thoại quay/nhận/phát mượt ở 4K. Thử Wi-Fi, thiết bị, nhiệt và pin trước buổi quay; nhiều máy chất lượng cao nên chuyển sang SFU (bản này chưa có).

Giữ trang foreground, màn hình sáng, không chuyển app/khóa máy. App xin screen wake lock khi được hỗ trợ, nhưng iOS/Android vẫn có thể dừng camera/encoder ở nền. Web không điều khiển được ứng dụng camera khác.

STUN mặc định `stun:stun.l.google.com:19302`. Nếu các mạng NAT/4G/5G chặn P2P, cấu hình TURN REST trong `.env`:

```dotenv
TURN_URLS=turn:turn.example.com:3478?transport=udp,turn:turn.example.com:3478?transport=tcp
TURN_SECRET=your-long-random-shared-secret
```

Coturn cần `use-auth-secret`, shared secret khớp, external IP/realm và firewall relay phù hợp. App cấp credential tạm 24 giờ, không gửi shared secret xuống browser.

## Kiểm thử

- `npm run build`: kiểm tra cú pháp và đóng gói server + frontend vào dist, không chứa env secrets.
- `npm test`: giới hạn 10 máy, quyền chủ phòng, sẵn sàng/quay/dừng, signaling cách ly, chunk retry, lỗi bucket và khôi phục.
- `node scripts/prove-neon.mjs`: ghi/đọc Postgres thật, nhận thay đổi qua Neon Realtime, upload/download private object và so SHA-256.
- `node scripts/qa-server.mjs`: chỉ QA loopback cổng 3001, dùng canvas giả lập camera. Không dùng server này để host cho người dùng.
- `node scripts/prove-videos.mjs <mã-phòng-QA>`: tải 3 video từ cùng lượt, so SHA-256 với spool, kiểm tra sidecar/timing.

Kết quả ở `verification/`. Đã thử 3 camera giả lập, chưa thử camera vật lý, micro hay 10 điện thoại thật. Camera canvas ở tab nền có thể bị giảm fps nên thời lượng media các file QA khác nhau; đây không phải kiểm thử đồng bộ khung hình trên thiết bị thực.

## Quản trị video và kiểm tra chất lượng

Xem [ADMIN.md](ADMIN.md) để hiểu quyền admin của chủ phòng, quy tắc xóa lượt cũ và các bước test trên Render.

### Quay nét, upload sau trên mạng yếu

- 10 Mbps tạo khoảng 75 MB/phút/camera (chưa tính audio). Kiểm tra dung lượng trống, thử 3 máy trước buổi quay và giữ tab mở, màn hình sáng cho tới khi mọi clip báo Đã lưu Neon.
- Nếu IndexedDB lỗi, RAM dự phòng chỉ tối đa 64 MB (khoảng 50 giây ở 10 Mbps). App cảnh báo; quay dài cần trình duyệt hỗ trợ bộ nhớ ổn định. Tab/OS bị đóng có thể làm mất bản RAM hoặc phần cuối chưa chốt.
- Không bắt đầu lượt mới khi video còn pending: server trả 409 trước khi xóa bất cứ bản nào. Admin vẫn có thể chủ động xóa clip lỗi muốn bỏ. Sau khi tất cả đã upload, lượt mới vẫn xóa video cũ theo chính sách của phòng.
- Không deploy/restart Render free giữa lúc quay/chờ upload: đĩa tạm có thể mất phiên upload. App giữ bản gốc chưa gửi khi phiên upload không còn, nhưng không tự tái tạo được phiên trên server.
