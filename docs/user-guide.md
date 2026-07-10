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
1. Chọn engine: **PostgreSQL / MySQL(MariaDB) / SQLite** (hoặc **Cloudflare D1** remote).
2. Dán connection string (`postgres://user:pass@host:5432/db`) — form tự điền host/port/db/user; **hoặc** tự điền từng ô.
3. Với DB cloud (Neon/Supabase/RDS/PlanetScale): chọn chế độ **SSL/TLS**:
   - **Encrypt only** — mã hoá, không verify cert (cloud nào cũng kết nối được ngay).
   - **Encrypt + verify certificate** — verify chuỗi cert + hostname (chống MITM). Provider dùng private CA (Supabase, Aiven…) thì dán CA cert (PEM) vào ô hiện ra; để trống sẽ verify bằng CA store của hệ điều hành.
   - Dán URL có `?sslmode=require` / `verify-full` sẽ tự chọn đúng chế độ.
4. Bấm **Test connection**:
   - **"Connected — read-only ✓"** → user DB chỉ có quyền đọc (lý tưởng).
   - **"⚠ Connected but the DB user can WRITE"** → user DB có quyền ghi. Vẫn dùng được (app chặn ghi ở tầng ứng dụng), nhưng nên cấp user chỉ-đọc.
   - **"Failed: …"** → sai thông tin, báo lỗi sạch (không lộ stack).
5. Bấm **Add & sync** — app quét schema (bảng/cột/khoá/row count) và lưu lại.

Từ mỗi connection có các mục: **Chat · Browse · Context**, cùng **Dashboards · Reports** trên thanh nav trên cùng.

> **Khuyến nghị an toàn:** Cấp cho connection một DB user **chỉ có quyền `SELECT`**, và trỏ vào **read replica** nếu có. Đây là ranh giới bảo vệ thật; các lớp chặn trong app chỉ là phòng thủ nhiều lớp, không thay thế việc cấp quyền tối thiểu.

---

## 3. Làm được những gì

### Chat với database
- Hỏi bằng ngôn ngữ tự nhiên; model tự khám phá schema qua tool và chạy SQL **chỉ-đọc** để trả lời (vòng lặp agentic, không phải RAG cố định).
- Kết quả kèm **SQL sửa/chạy lại được**, **export CSV**, và **xem biểu đồ**.
- **Màn hình rộng tự tách 2-3 cột**: hội thoại bên trái (kết quả thu thành chip 1 dòng, bấm để mở), panel kết quả bên phải (SQL + bảng + chart, giữ nguyên state khi chuyển giữa các query), màn rất rộng thêm cột danh sách query của phiên. Màn hẹp giữ mọi thứ inline.
- Hỗ trợ 3 engine + cloud: PostgreSQL, MySQL/MariaDB, SQLite, Cloudflare D1.

### Lớp bối cảnh (Context Studio) — điểm khác biệt
- **Business glossary, chú thích schema, quan hệ thủ công, verified queries** — bạn bồi đắp theo thời gian; app đưa vào ngữ cảnh của agent.
- **Multilingual embedding** (chạy tốt tiếng Việt), tìm kiếm kết hợp keyword + vector.
- **Knowledge Inbox** — chưng cất một phiên chat thành các gợi ý để bạn duyệt; cái được duyệt sẽ làm giàu kho ngữ cảnh.
- **Export/import YAML** để backup bằng Git.

### An toàn (physical safety layer)
- Mọi truy vấn đi qua: kết nối chỉ-đọc → kiểm AST (chỉ `SELECT`, chặn CTE-ghi) → denylist hàm nguy hiểm theo dialect (`pg_terminate_backend`, `COPY … TO PROGRAM`, `INTO OUTFILE`, `load_extension`, `ATTACH`, …) → tự chèn `LIMIT` → ghi audit log.
- **Mã hoá credential** (AES-256-GCM), lưu vết mọi lần chạy.

### Analyst, Dashboards & Reports
- **Investigate mode** — với câu hỏi "tại sao / so sánh / xu hướng", agent viết kế hoạch phân tích, chạy chuỗi truy vấn drill-down, và kết luận kèm bằng chứng (không trả lời một-phát). Có nút **"Analyze deeper"** biến bất kỳ kết quả nào thành một cuộc điều tra; agent tự **hỏi lại khi mơ hồ** và tự sửa SQL lỗi.
- **Pin & Dashboards** — ghim kết quả chat thành widget; gom widget lên dashboard; **chia sẻ chỉ-đọc** qua link ký. Người xem ẩn danh chỉ thấy kết quả cache, **không** chạy query, **không** thấy SQL.
- **Reports** — gom widget/verified query làm nguồn, để model soạn một report markdown có cấu trúc (executive summary → sections → phụ lục SQL), có version, tạo lại được, in ra PDF.

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
