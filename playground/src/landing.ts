import { mountChrome } from "./shared/chrome";
import "./shared/styles.css";

mountChrome("");

const cards = [
  {
    id: "react",
    name: "React",
    color: "#149eca",
    entry: "presigned-multipart-upload/react",
    api: "useUploader()",
  },
  {
    id: "angular",
    name: "Angular",
    color: "#dd0031",
    entry: "presigned-multipart-upload/angular",
    api: "createAngularUploader()",
  },
];

document.getElementById("app")!.innerHTML = cards
  .map(
    (c) => `
    <a class="card fw-card" href="/${c.id}.html" data-testid="fw-${c.id}">
      <span class="fw-badge" style="background:${c.color}">${c.name.slice(0, 2)}</span>
      <h3>${c.name}</h3>
      <p><code>${c.api}</code> from <code>${c.entry}</code></p>
    </a>`,
  )
  .join("");
