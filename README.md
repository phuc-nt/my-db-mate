# My DB Mate

**Chat với database của bạn** — hỏi bằng ngôn ngữ tự nhiên, nhận câu trả lời dựa trên SQL thật, không cần viết truy vấn tay.

---

## Tại sao tôi làm sản phẩm này

Tôi làm cho chính những người như tôi: **DevOps/DBA quản lý database lớn trong production**. Công việc thường ngày là nhận đủ loại yêu cầu lấy data ad-hoc từ business, product, finance… Dashboard có sẵn thì cứng nhắc — luôn thiếu đúng cái lát cắt data mà người ta cần lúc đó. Còn viết SQL tay mỗi lần thì tốn thời gian, nhất là với hệ thống nhiều bảng, business logic chồng chéo.

"Chat với DB để ra SQL" nghe như lời giải hiển nhiên. Nhưng khi bắt tay làm, tôi nhận ra điều quan trọng nhất:

### Linh hồn sản phẩm không phải là generate SQL

Convert câu hỏi thành SQL **không còn là bài toán khó** — LLM bây giờ làm khá tốt. Cái khó thật nằm ở **context** để AI generate ĐÚNG:

- Tên cột thực tế hiếm khi tự giải thích — `usr_stat_cd` nghĩa là gì? `status` là `'A'/'I'` hay `'active'/'inactive'`?
- "Khách hàng active" theo nghiệp vụ map vào cấu trúc DB nào?
- Những query tay, report cũ — tri thức bộ lạc (tribal knowledge) quý giá mà không nằm trong schema.

Một LLM 2026 đủ giỏi để đoán tên viết tắt thông thường. Nhưng nó **không thể đoán** những enum code mờ nghĩa, những quy ước riêng của từng hệ thống, những định nghĩa nghiệp vụ chỉ tồn tại trong đầu người DBA. Đó là khoảng trống mà không model nào lấp được — chỉ có **con người enrich dần** mới lấp được.

Nên **moat** của My DB Mate không phải là text-to-SQL. Nó là **lớp context** — business glossary, chú thích schema, verified queries — mà một team bồi đắp theo thời gian, để AI ngày càng hiểu đúng hệ thống của họ. Giống RAG, nhưng cho structured data + business knowledge.

### Và an toàn là điều kiện tiên quyết, không phải tính năng phụ

Vì thao tác trên **big DB production**, một AI "sáng tạo quá đà" là rủi ro có thật. Nên My DB Mate được xây quanh một **lớp an toàn vật lý**: chỉ đọc (read-only) được ép ở nhiều tầng, mọi truy vấn đi qua một choke point kiểm duyệt, credential được mã hoá, mọi lần chạy đều ghi audit. AI **không bao giờ** được phép làm hỏng DB của bạn — đó là ràng buộc thiết kế, không phải tuỳ chọn.

---

## Bắt đầu

| Bạn là… | Đọc file này |
|---|---|
| **Người dùng** muốn tự cài & dùng | [Hướng dẫn sử dụng (tiếng Việt)](docs/user-guide.md) |
| **Nhờ một AI agent cài giúp** ("đọc file này rồi cài + hướng dẫn tôi") | [`docs/agent-setup.md`](docs/agent-setup.md) |
| Muốn xem **làm được gì + stack + safety model** | [Features & Technical Reference](docs/features.md) |

Cài nhanh (cần Docker):

```bash
./setup.sh                          # tạo .env, sinh khoá mã hoá, hỏi OpenRouter key
docker compose --profile full up    # app + DB + tự migrate → http://localhost:3000
```

---

## Giấy phép

Phát hành theo **[PolyForm Noncommercial License 1.0.0](LICENSE.md)** — tự do dùng, sửa, chia sẻ cho mọi mục đích **phi thương mại** (cá nhân, học tập, nghiên cứu, tổ chức phi lợi nhuận).

**Dùng cho mục đích thương mại cần giấy phép riêng — liên hệ tác giả tại phucnt0@gmail.com.**

Copyright © 2026 Trọng Phúc ([phuc-nt](https://github.com/phuc-nt)).
