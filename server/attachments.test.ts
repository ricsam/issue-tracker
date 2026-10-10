import { expect, test } from "bun:test";
import { attachmentIds } from "./attachments";

test("attachment references normalize encoded IDs, Markdown entities and URL paths", () => {
  const id = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
  for (const value of [
    `/api/uploads/${id}/photo.png`,
    `/api/uploads/%61${id.slice(1)}/photo.png`,
    `[photo](/api/uploads/&#97;${id.slice(1)}/photo.png)`,
    `[photo](/api/other/../uploads/${id}/photo.png)`,
    `[photo](/api\\/uploads/${id}/photo.png)`,
    `![photo][file]\n\n[file]: /api/uploads/%61${id.slice(1)}/photo.png`,
    `\`/api/uploads/${id}/photo.png\``,
  ]) expect(attachmentIds(value)).toEqual([id]);
  expect(attachmentIds(`/api/uploads/${id}/a /api/uploads/${id}/b`)).toEqual([id]);
  expect(attachmentIds("no attachment /api/uploads/not-a-uuid/file")).toEqual([]);
});
