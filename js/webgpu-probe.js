// Shared WebGPU availability probe for the main thread and the LLM worker.
//
// `navigator.gpu` merely means the API exists; `requestAdapter()` can still
// return null (disabled flag, policy, remote desktop, or a GPU left unusable
// after a prior device hang). Always probe an adapter before enabling LLM UI.

const ADAPTER_OPTIONS = [
  {},
  { powerPreference: 'high-performance' },
  { powerPreference: 'low-power' },
];

export async function requestWebGpuAdapter() {
  if (typeof navigator === 'undefined' || !navigator.gpu) return null;
  for (const options of ADAPTER_OPTIONS) {
    try {
      const adapter = await navigator.gpu.requestAdapter(options);
      if (adapter) return adapter;
    } catch (_) {
      // Try the next preference.
    }
  }
  return null;
}

export async function probeWebGpuAvailable() {
  if (typeof navigator === 'undefined' || !('gpu' in navigator)) {
    return {
      available: false,
      reason:
        'Transcript correction and form filling need WebGPU. Use a recent Chrome or Edge on a machine with a GPU.',
    };
  }
  const adapter = await requestWebGpuAdapter();
  if (adapter) return { available: true, reason: '' };
  return {
    available: false,
    reason:
      'WebGPU is present but no GPU adapter was found. If you saw a GPU crash earlier, fully restart the browser. ' +
      'Otherwise update your graphics drivers, avoid Remote Desktop for this step, and in Chrome/Edge check ' +
      'chrome://flags that WebGPU is enabled (chrome://gpu shows the status).',
  };
}

export const WEBGPU_ADAPTER_ERROR =
  'No WebGPU adapter found. The local assistant needs a working GPU in Chrome or Edge. ' +
  'After a GPU crash, restart the browser completely, then try again.';
