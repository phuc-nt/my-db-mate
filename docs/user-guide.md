# Hướng dẫn sử dụng My DB Mate

*Chat với database bằng tiếng Việt — hỏi bằng ngôn ngữ tự nhiên, nhận câu trả lời dựa trên SQL thật, không cần viết truy vấn tay.*

Tài liệu này hướng dẫn: (1) cài đặt, (2) kết nối database, (3) những gì làm được, (4) các giới hạn hiện tại.

---

## 1. Cài đặt

**Yêu cầu:** Docker (chỉ cần vậy nếu chạy theo hướng container).

**Chạy nhanh (2 lệnh):**

```bash
./setup.sh                          # tạo .env, sinh khoá mã hoá, hỏi OpenRouter API key
docker compose --profile full up    # app + Postgres/pgvector + tự migrate → http://localhost:3000
```

Container tự chạy migration khi khởi động và nhúng sẵn model embedding (chạy offline), nên không cần cài thêm gì.

> **Bỏ qua bước build (nhanh hơn nhiều):** kéo image dựng sẵn từ GitHub Container Registry thay vì build local:
>
> ```bash
> docker compose --profile full pull   # lấy ghcr.io/phuc-nt/my-db-mate:latest
> docker compose --profile full up
> ```

### Cần chuẩn bị

- **OpenRouter API key** — app dùng LLM qua [OpenRouter](https://openrouter.ai) (BYOK — bạn tự mang key). Mặc định model `qwen/qwen3.7-max`, đổi được trong `.env` (`OPENROUTER_MODEL`).
- File `.env` (do `setup.sh` tạo) chứa 3 biến chính:
  - `OPENROUTER_API_KEY` — key LLM của bạn
  - `DATABASE_URL` — DB nội bộ của app (Postgres + pgvector), mặc định đã trỏ đúng container
  - `CREDENTIAL_ENC_KEY` — khoá AES-256-GCM để mã hoá credential DB đích (setup.sh tự sinh)

### Chạy dev (không dùng container app)

```bash
./setup.sh                          # hoặc: cp .env.example .env rồi tự điền
docker compose up -d app-db         # chỉ DB của app
npm install
export $(grep -v '^#' .env | xargs)
npm run db:migrate
npm run dev                         # http://localhost:3000
```

**Kiểm tra kết nối LLM trước khi bắt đầu:**

```bash
npm run smoke:llm      # test model gọi tool + độ chính xác với OPENROUTER_API_KEY của bạn
```

---

## 2. Kết nối database

> **Chưa có DB để thử?** Trang Connections (khi trống) có nút **"Try with a sample database"** — tạo một DB shop mẫu (orders/products/customers, mã enum kiểu `ord_sts_cd`) kèm sẵn business glossary, rồi đưa bạn thẳng vào chat.

Mở `/connections`, bấm thêm connection:

0. (Tuỳ chọn) Chọn **Provider preset** (Neon/Supabase/RDS/PlanetScale/TiDB/CockroachDB/Aiven…) — tự điền engine/port/SSL + hiện ghi chú riêng của provider. Mọi ô vẫn sửa được sau đó. Xem bảng tương thích đầy đủ trong [features.md](features.md).
1. Chọn engine: **PostgreSQL / MySQL(MariaDB) / SQLite / SQL Server** (hoặc **Cloudflare D1** remote). Với SQL Server, dùng login chỉ có `db_datareader` để read-only thật, và cấp thêm `GRANT SHOWPLAN` (quyền metadata-only) để hệ thống ước lượng được chi phí query — thiếu quyền này thì mọi query đều bị hỏi xác nhận trước khi chạy.
2. Dán connection string (`postgres://user:pass@host:5432/db`) — form tự điền host/port/db/user; **hoặc** tự điền từng ô.
3. Với DB cloud (Neon/Supabase/RDS/PlanetScale): chọn chế độ **SSL/TLS**:
   - **Encrypt only** — mã hoá, không verify cert (cloud nào cũng kết nối được ngay).
   - **Encrypt + verify certificate** — verify chuỗi cert + hostname (chống MITM). Provider dùng private CA (Supabase, Aiven…) thì dán CA cert (PEM) vào ô hiện ra; để trống sẽ verify bằng CA store của hệ điều hành.
   - Dán URL có `?sslmode=require` / `verify-full` sẽ tự chọn đúng chế độ.
4. Bấm **Test connection**:
   - **"Connected — read-only ✓"** → user DB chỉ có quyền đọc (lý tưởng).
   - **"⚠ Connected but the DB user can WRITE"** → user DB có quyền ghi. Vẫn dùng được (app chặn ghi ở tầng ứng dụng), nhưng nên cấp user chỉ-đọc.
   - **"Failed: …"** → sai thông tin, báo lỗi sạch (không lộ stack).
5. (Tuỳ chọn) **Connect via SSH tunnel** — DB nằm sau bastion host: tick ô này, điền SSH host/port/user + private key (PEM) hoặc password. Mọi kết nối + query đi qua tunnel; TLS tới DB vẫn verify theo hostname thật. Key được mã hoá khi lưu như password DB.
6. (Tuỳ chọn) **Enable query accelerator** — nếu DB bạn có bảng lớn, tick ô này để tăng tốc độ query nặng. Hệ thống sẽ cache bảng thành Parquet file và chạy query trên snapshot (thay vì DB trực tiếp), giảm tải. Điền TTL cache (mặc định 1 giờ) — kết quả sẽ ghi nhãn "⚡ Accelerated · snapshot …" để bạn biết data cũ bao lâu. Chỉ áp dụng cho simple SELECT (không CTE, không function lạ); query phức tạp tự chạy bình thường.
7. Bấm **Add & sync** — app quét schema (bảng/cột/khoá/row count) và lưu lại.

Mỗi connection mở thành **một workspace** tại `/db/<id>` với thanh section: **💬 Chat · 🗂 Schema · 📚 Context · ⏰ Automations** (link cũ Chat/Browse/Context tự chuyển hướng). Nav trên cùng gọn còn: **Connections · Library · ⚙ Settings**.

- **Library** gộp Dashboards + Reports + Notebooks vào một danh sách, lọc theo loại/connection, tạo mới ngay tại đó.
- **Settings** (global): chọn **LLM provider** — OpenRouter / OpenAI / Anthropic (Claude) / Google (Gemini) — dán API key (lưu mã hóa, có nút **Test** trước khi Save) + quản lý **API keys cho MCP**. Nhập **model ID chính xác** mà tài khoản bạn truy cập được (tên model đổi theo thời gian và theo tier). Không cấu hình gì ở đây thì dùng env fallback: `LLM_PROVIDER` + `<PROVIDER>_API_KEY`/`<PROVIDER>_MODEL` (mặc định `OPENROUTER_API_KEY`).
- Trong Chat: panel kết quả có tab **🗂 Schema** để xem bảng/cột/sample không rời hội thoại; khi có gợi ý context chờ duyệt sẽ hiện **badge trên mục Context** + chip nhắc sau mỗi lượt; nút **⏰ Schedule** trên mỗi kết quả để đặt lịch chạy định kỳ (quản lý trong Automations).
- **Schema → Saved**: bookmark và verified query nằm cạnh nhau; bấm **Promote to verified** để nâng bookmark thành ví dụ few-shot cho agent.
- **Schema → Health**: mỗi cảnh báo data có nút **Ask agent →** mở chat với câu hỏi điền sẵn.
- **Automation cho analyst**: dashboard có nút **⏰ Auto-refresh** (cron); report có **⏰ Schedule** tự sinh version mới + gửi markdown đầy đủ tới webhook (mỗi lần chạy = 1 LLM call, tối thiểu hàng giờ); tab **Automations** thêm **🔎 Data monitor** — theo dõi bảng bạn chọn, chụp row-count/null-rate/avg mỗi lần chạy, lệch quá ngưỡng thì bắn webhook alert (lần đầu chỉ ghi baseline; lệch dưới 20 rows tuyệt đối được bỏ qua). Lịch giờ **sống qua restart**. Notebook có **↻ Re-run queries** (data mới, narrative giữ nguyên + stamp thời điểm); report nhận **notebook làm nguồn**. Health tab có **Check anomalies** từng cột không cần chat; Investigate có mức **Deep** (~2x budget) khi cần đào sâu.
- **Vòng lặp tin cậy trong Chat**: dưới mỗi câu trả lời có **badge nguồn gốc + độ tin cậy** (đã dùng verified query/glossary nào); bấm **👎** khi trả lời sai → chọn loại lỗi, sửa SQL ngay trong dialog, chạy lại, và **lưu bản sửa thành verified query** (lần hỏi tương tự sau sẽ đúng). Query nặng cần xác nhận giờ hiện **2 ứng viên SQL** (bản gốc + bản viết khác, kèm risk từng bản) để bạn chọn. Kết quả dạng chuỗi thời gian tự mở **chart**; dưới bảng có 1 dòng **lineage** (từ bảng nào, lọc gì, nhóm gì); nút ẩn/hiện SQL nhớ theo từng connection; chip 💡 gợi ý context mở **popover duyệt ngay trong chat**.

> **Khuyến nghị an toàn:** Cấp cho connection một DB user **chỉ có quyền `SELECT`**, và trỏ vào **read replica** nếu có. Đây là ranh giới bảo vệ thật; các lớp chặn trong app chỉ là phòng thủ nhiều lớp, không thay thế việc cấp quyền tối thiểu.

---

## 3. Làm được những gì

### Chat với database
- Hỏi bằng ngôn ngữ tự nhiên; model tự khám phá schema qua tool và chạy SQL **chỉ-đọc** để trả lời (vòng lặp agentic, không phải RAG cố định).
- Kết quả kèm **SQL sửa/chạy lại được**, **export CSV**, **xem biểu đồ**, và **copy SQL / copy kết quả** 1 chạm.
- **Gợi ý câu hỏi tiếp** sau mỗi câu trả lời (bấm để hỏi luôn); màn chat trống gợi ý câu mẫu từ verified queries của bạn. Tắt được.
- **Pivot nhanh** ngay trên bảng kết quả (group-by × giá trị × hàm tổng hợp) không cần viết lại SQL, trên số rows đã tải.
- **Bước agent dễ đọc**: mỗi tool hiện nhãn tiếng người + trạng thái đang chạy/xong/lỗi; phần suy luận của model (nếu có) hiện gọn.
- **Màn hình rộng tự tách 2-3 cột**: hội thoại bên trái (kết quả thu thành chip 1 dòng, bấm để mở), panel kết quả bên phải (SQL + bảng + chart, giữ nguyên state khi chuyển giữa các query), màn rất rộng thêm cột danh sách query của phiên. Màn hẹp giữ mọi thứ inline.
- Hỗ trợ 3 engine + cloud: PostgreSQL, MySQL/MariaDB, SQLite, Cloudflare D1.

### Lớp bối cảnh (Context Studio) — điểm khác biệt
- **Business glossary, chú thích schema, quan hệ thủ công, verified queries** — bạn bồi đắp theo thời gian; app đưa vào ngữ cảnh của agent.
- **Multilingual embedding** (chạy tốt tiếng Việt), tìm kiếm kết hợp keyword + vector.
- **Knowledge Inbox** — chưng cất một phiên chat thành các gợi ý để bạn duyệt; cái được duyệt sẽ làm giàu kho ngữ cảnh.
- **Mine query history** — biến query log có sẵn thành ngữ cảnh: đọc `pg_stat_statements` (PostgreSQL) / `performance_schema` digest (MySQL), hoặc dán log; đề xuất verified queries + quan hệ (từ JOIN lặp lại chưa khai báo FK) vào Inbox để bạn duyệt. Literal được parametrize (`= ?`) trước khi lưu nên không mang PII vào kho ngữ cảnh. Không tự áp dụng — luôn qua Inbox.
- **Export/import YAML** để backup bằng Git.

### An toàn (physical safety layer)
- Mọi truy vấn đi qua: kết nối chỉ-đọc → kiểm AST (chỉ `SELECT`, chặn CTE-ghi) → denylist hàm nguy hiểm theo dialect (`pg_terminate_backend`, `COPY … TO PROGRAM`, `INTO OUTFILE`, `load_extension`, `ATTACH`, …) → tự chèn `LIMIT` → ghi audit log.
- **Mã hoá credential** (AES-256-GCM), lưu vết mọi lần chạy.
- **Query nặng phải được bạn duyệt**: hệ thống ước lượng chi phí (EXPLAIN) trước khi chạy — query ước lượng nặng sẽ dừng chờ xác nhận. Bấm `view →` trên chip query → **Re-run** → **Confirm & run anyway**. Agent không tự duyệt được (gõ "cho phép" trong chat không có tác dụng); sau khi bạn xác nhận, kết quả tự ghi lại vào hội thoại để agent phân tích tiếp.

### Analyst, Dashboards & Reports
- **Investigate mode** — với câu hỏi "tại sao / so sánh / xu hướng", agent viết kế hoạch phân tích, chạy chuỗi truy vấn drill-down, và kết luận kèm bằng chứng (không trả lời một-phát). Có nút **"Analyze deeper"** biến bất kỳ kết quả nào thành một cuộc điều tra; agent tự **hỏi lại khi mơ hồ** và tự sửa SQL lỗi.
- **Pin & Dashboards** — ghim kết quả chat thành widget; gom widget lên dashboard; **chia sẻ chỉ-đọc** qua link ký. Người xem ẩn danh chỉ thấy kết quả cache, **không** chạy query, **không** thấy SQL.
- **Reports** — gom widget/verified query làm nguồn, để model soạn một report markdown có cấu trúc (executive summary → sections → phụ lục SQL), có version, tạo lại được, in ra PDF.

### Metrics & bản tin digest (kiểu Tableau Pulse)
- **Theo dõi chỉ số**: một metric = 1 câu SQL trả đúng 2 cột `(mốc thời gian, giá trị)`. Cách nhanh nhất: hỏi chat ("doanh thu theo tháng") → bấm **📈 Track as metric** trên kết quả (tên + grain điền sẵn) → tab **Metrics** hiện card sparkline + badge % thay đổi. Chọn "hướng tốt" (▲ tốt cho doanh thu, ▼ tốt cho lỗi/huỷ đơn) để badge tô màu đúng nghĩa.
- **Digest theo lịch**: tab Metrics → **⏰ Digest schedule** → chọn tuần/ngày/giờ + webhook (tuỳ chọn). Mỗi lần chạy: app tự tính delta / so trung bình 4 kỳ / outlier ±2σ (tất định, không phải LLM đoán số), rồi 1 LLM call duy nhất diễn giải thành bản tin markdown, gộp thêm cảnh báo data-drift monitor nếu có, và POST vào webhook. LLM lỗi thì bản tin thuần số vẫn được gửi. Không có webhook thì xem trong **Automations → Show runs**.
- **Target (mục tiêu)**: điền field *Target* trong form metric → card hiện dòng 🎯 on/off-track theo "hướng tốt" (metric neutral chỉ hiện % khoảng cách, không phán tốt/xấu); digest tự thêm cờ below/above target.
- **Dimensions (tìm thủ phạm)**: điền ≤3 tên cột vào field *Dimensions* (vd `ord_sts_cd, region`) → digest chỉ ra slice nào kéo metric lên/xuống ("giảm 65% — chủ yếu do status D, 58% tổng biến động"). SQL bị giới hạn: SELECT + GROUP BY thuần (không CTE); cột sai sẽ báo lỗi ngay lúc lưu.
- **Quiet mode**: khi tạo Digest schedule chọn "Only send when something changed" → mọi metric yên ắng thì không gọi LLM, không bắn webhook (run history vẫn ghi "quiet — skipped"). Metric trượt target dài hạn KHÔNG phá quiet — chỉ biến động thật mới kích hoạt gửi.
- **Nối webhook đi đâu?** Bất kỳ endpoint HTTP nào nhận JSON: n8n (Webhook node), Zapier (Catch Hook), hoặc script tự viết rồi đẩy vào Slack/Telegram. Payload: `{ name, connectionId, digest (markdown), metrics: [{name, latest, deltaPct, flags}], monitorFindings }`. Webhook nội bộ (localhost/LAN) mặc định bị chặn SSRF — mở riêng từng host:port qua env `WEBHOOK_PRIVATE_ALLOWLIST=host:port`.

### Dashboard theo khoảng thời gian
- Khi pin widget, viết SQL dùng `{{from}}` / `{{to}}` (không kèm nháy — ví dụ `WHERE order_date BETWEEN {{from}} AND {{to}}`) → widget có badge 📅 và phản ứng với thanh **Date range** (7D/30D/90D/YTD/tuỳ chọn) trên đầu dashboard.
- Chạy theo range là **tạm thời**: chỉ hiển thị cho bạn, không ghi đè cache. Share link **luôn** thấy bản mặc định 30 ngày gần nhất (người xem ẩn danh không bao giờ chạy query — như cũ).
- Widget cũng có nút **⚙** để đổi kiểu chart: KPI tile (số to + delta), stacked bar, multi-series line (kết quả dạng `(x, series, y)`).

### DB client & phân tích
- **Schema browser + ERD** — duyệt bảng → cột (type/PK/FK/row count) + sample rows; xem sơ đồ quan hệ (ERD) tương tác.
- **Execution-plan viewer** — EXPLAIN một query (chỉ xem plan, không chạy) kèm cảnh báo full-scan.
- **Bookmarks + export phong phú** — lưu query để chạy lại 1-click; export CSV (chống chèn công thức), JSON, hoặc SQL-INSERT theo dialect.
- **Anomaly detection** — trong investigate mode, agent kiểm tra NULL-rate và outlier số (chỉ aggregate) làm bằng chứng.
- **Data Health** — quét thủ công, gắn cờ cột nhiều NULL / một-giá-trị / dạng-id, kèm badge quét-một-phần.
- **Notebooks** — lưu một phiên chat thành notebook chỉ-đọc, chia sẻ được (câu hỏi → SQL → kết quả → tường thuật); cột đánh dấu nhạy cảm sẽ bị bỏ khỏi bản chia sẻ.

### Kết nối Claude với DB của bạn (MCP)
Tạo API key (giới hạn theo connection) trong app, rồi:

```bash
claude mcp add my-db-mate -- npx tsx scripts/mcp-server-entry.ts
# env: MDM_API_KEY=<key>, DATABASE_URL, OPENROUTER_API_KEY
```

Claude sẽ có `ask_database` / `run_sql` / `get_schema_context` / `search_verified_queries` — tất cả đi qua cùng lớp an toàn, glossary, và audit log.

---

## 4. Giới hạn hiện tại (chưa làm)

Sản phẩm đang ở phạm vi **self-hosted, single-user (dogfood)**. Các mục sau **cố ý** để ngoài phạm vi hiện tại:

- **Multi-user / RBAC / hàng đợi duyệt** — chưa có phân quyền nhiều người dùng. Trước khi mở ra internet, hãy đặt một auth proxy phía trước.
- **Chat xuyên nhiều DB** — một phiên chat hiện chỉ gắn với một connection.
- **Chỉ đọc (read-only)** — app không ghi/sửa dữ liệu; đây là ràng buộc thiết kế, không phải thiếu sót.
- **TLS mặc định không verify cert** — chế độ "Encrypt only" chỉ **mã hoá**, không verify certificate (kênh không chống MITM). Khi đường truyền tới DB đi qua mạng không tin cậy, hãy chọn **"Encrypt + verify certificate"** (dán CA cert nếu provider dùng private CA).
- **Share link là "capability"** — link chia sẻ dashboard/report dùng chuỗi 128-bit khó đoán; **ai có link đều xem được** kết quả cache. Hãy coi share link như mật khẩu; chỉ dùng cho localhost/LAN hoặc chia sẻ tin cậy.
- **Eval-regression guard trên production DB thật** — chưa có.

---

## Câu hỏi & giấy phép

- Giấy phép: **PolyForm Noncommercial 1.0.0** — tự do dùng cho mục đích **phi thương mại** (cá nhân, học tập, tổ chức phi lợi nhuận). Dùng cho **mục đích thương mại** phải liên hệ tác giả: **phucnt0@gmail.com**.
- Chi tiết an toàn kỹ thuật & tính năng bằng tiếng Anh: xem [README.md](../README.md).
