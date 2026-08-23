# Vue

```bash
npm install presigned-multipart-upload
```

One package for every framework — no `/vue` package to add, no install flag. Vue
is an *optional* peer, so npm does not install it; you already have it. The
binding lives at a subpath, and that import is the only thing that touches Vue:

```ts
import { createBatch } from "presigned-multipart-upload";      // no Vue
import { useUpload } from "presigned-multipart-upload/vue";    // Vue
```

Vue is an optional peer dependency.

## `useUpload`

```vue
<script setup lang="ts">
import { createBatch } from "presigned-multipart-upload";
import { useUpload } from "presigned-multipart-upload/vue";

const props = defineProps<{ files: File[] }>();

const batch = createBatch({ files: props.files, transport });
const { snapshot, start, pause, resume, cancel } = useUpload(batch);
</script>

<template>
  <progress :value="snapshot.progress.percent" max="100" />
  <span>{{ snapshot.status }}</span>

  <button v-if="snapshot.status === 'idle'" @click="start()">Upload</button>
  <button v-else-if="snapshot.status === 'uploading'" @click="pause()">Pause</button>
  <button v-else-if="snapshot.status === 'paused'" @click="resume()">Continue</button>
  <button v-else-if="snapshot.status === 'failed'" @click="resume()">Retry</button>
  <button @click="cancel()">Cancel</button>

  <ul>
    <li v-for="upload in snapshot.uploads" :key="upload.id">
      {{ upload.file.name }} — {{ upload.progress.percent }}% — {{ upload.status }}
    </li>
  </ul>
</template>
```

`snapshot` is a `shallowRef`, not a `ref`. Snapshots are frozen and replaced
whole, so deep reactivity would walk every part on every progress tick to
discover what the identity change already told us.

## Computed values

```ts
import { computed } from "vue";

const failed = computed(() =>
  snapshot.value.uploads.filter((upload) => upload.status === "failed"),
);

const canRetry = computed(() =>
  snapshot.value.uploads.some((upload) => upload.resumable),
);
```

## Events

```ts
import { onScopeDispose } from "vue";

const off = batch.on("upload:succeeded", ({ uploadId }) => {
  notify(`${uploadId} finished`);
});

onScopeDispose(off);
```

## Cleanup

The subscription is bound to the owning effect scope, so a component that
unmounts mid-upload stops tracking automatically. There is also an explicit
`stop()` if you are using the composable outside a component.

```ts
const { stop } = useUpload(batch);
stop();
```

The upload itself keeps running — pause or cancel it explicitly if that is what
you want.
