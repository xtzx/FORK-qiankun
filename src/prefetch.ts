/**
 * @author Kuitos
 * @since 2019-02-26
 */

import type { Entry, ImportEntryOpts } from 'import-html-entry';
// 动态加载 HTML 入口文件及其相关资源（如 JavaScript 和 CSS）
import { importEntry } from 'import-html-entry';
import { isFunction } from 'lodash';
// single-spa 通过维护一个应用状态的内部数据结构来跟踪每个注册应用的状态。
import { getAppStatus, getMountedApps, NOT_LOADED } from 'single-spa';
import type { AppMetadata, PrefetchStrategy } from './interfaces';

declare global {
  interface NetworkInformation {
    saveData: boolean;
    effectiveType: string;
  }
}

declare global {
  interface Navigator {
    connection: {
      saveData: boolean;
      effectiveType: string;
      type: 'bluetooth' | 'cellular' | 'ethernet' | 'none' | 'wifi' | 'wimax' | 'other' | 'unknown';
    };
  }
}

/**
 * @description: 模拟了 requestIdleCallback 的行为，计算剩余时间并调用回调函数。
 */
function idleCall(cb: IdleRequestCallback, start: number) {
  cb({
    didTimeout: false,
    timeRemaining() {
      return Math.max(0, 50 - (Date.now() - start));
    },
  });
}

// 兼容处理 requestIdleCallback
// RIC and shim for browsers setTimeout() without it idle
let requestIdleCallback: (cb: IdleRequestCallback) => any;

if (typeof window.requestIdleCallback !== 'undefined') {
  requestIdleCallback = window.requestIdleCallback;
} else if (typeof window.MessageChannel !== 'undefined') {
  // 使用 MessageChannel 模拟 requestIdleCallback
  // The first recommendation is to use MessageChannel because
  // it does not have the 4ms delay of setTimeout
  const channel = new MessageChannel();
  const port = channel.port2;
  const tasks: IdleRequestCallback[] = [];
  channel.port1.onmessage = ({ data }) => {
    const task = tasks.shift();
    if (!task) {
      return;
    }
    idleCall(task, data.start);
  };
  requestIdleCallback = function(cb: IdleRequestCallback) {
    tasks.push(cb);
    port.postMessage({ start: Date.now() });
  };
} else {
  requestIdleCallback = (cb: IdleRequestCallback) => setTimeout(idleCall, 0, cb, Date.now());
}

/**
 * @description: 判断网络是否慢
 * 判断当前网络是否为慢速网络，如果是慢速网络则不进行预加载。
 *
 * 判断条件:
 * navigator.connection.saveData: 检查用户是否启用了数据节省模式。如果启用了数据节省模式，则认为网络慢。
 * navigator.connection.type: 检查网络连接类型。如果网络连接类型不是 wifi 或 ethernet，则认为网络慢。
 * navigator.connection.effectiveType: 检查网络的有效类型。如果有效类型匹配正则表达式 /([23])g/，即网络类型为 2G 或 3G，则认为网络慢。
 *
 * 可以考虑使用更详细的网络信息来判断网络是否慢，例如
 * navigator.connection.downlink < 1.5 || // 下行速度小于1.5Mbps
 * navigator.connection.rtt > 300 // 往返时间大于300ms
 */
const isSlowNetwork = navigator.connection
  ? navigator.connection.saveData ||
    (navigator.connection.type !== 'wifi' &&
      navigator.connection.type !== 'ethernet' &&
      /([23])g/.test(navigator.connection.effectiveType))
  : false;

/**
 * 预加载资源，如果当前网络离线或者慢速网络 则不进行预加载。
 * prefetch assets, do nothing while in mobile network
 */
function prefetch(entry: Entry, opts?: ImportEntryOpts): void {
  if (!navigator.onLine || isSlowNetwork) {
    return;
  }

  requestIdleCallback(async () => {
    // importEntry 返回一个 Promise，解析后的对象包含以下属性：
    //     template：解析后的 HTML 模板字符串。
    //     execScripts：一个函数，用于加载并执行所有外部脚本，返回一个 Promise，解析为脚本的导出对象。
    //     getExternalScripts：一个函数，返回一个 Promise，解析为所有外部脚本的数组。
    //     getExternalStyleSheets：一个函数，返回一个 Promise，解析为所有外部样式表的数组。
    // 不会直接返回这个动态加载的脚本
    const { getExternalScripts, getExternalStyleSheets } = await importEntry(entry, opts);
    requestIdleCallback(getExternalStyleSheets);
    requestIdleCallback(getExternalScripts);
  });
}

/**
 * @description:在 single-spa:first-mount 事件触发后预加载未加载的应用。
 * 一般情况都是这种，因为我们需要等待第一个应用加载完成后再预加载其他应用。
 */
function prefetchAfterFirstMounted(apps: AppMetadata[], opts?: ImportEntryOpts): void {
  window.addEventListener('single-spa:first-mount', function listener() {
    const notLoadedApps = apps.filter((app) => getAppStatus(app.name) === NOT_LOADED);

    if (process.env.NODE_ENV === 'development') {
      const mountedApps = getMountedApps();
      console.log(`[qiankun] prefetch starting after ${mountedApps} mounted...`, notLoadedApps);
    }

    notLoadedApps.forEach(({ entry }) => prefetch(entry, opts));

    window.removeEventListener('single-spa:first-mount', listener);
  });
}

/**
 * @description: 立即预加载所有应用
 * 只有配置了 'all' 才会进入
 */
export function prefetchImmediately(apps: AppMetadata[], opts?: ImportEntryOpts): void {
  if (process.env.NODE_ENV === 'development') {
    console.log('[qiankun] prefetch starting for apps...', apps);
  }

  apps.forEach(({ entry }) => prefetch(entry, opts));
}

/**
 * @description: 用于根据不同的预加载策略来预加载应用资源
 * 支持数组、函数和布尔值三种策略。
 */
export function doPrefetchStrategy(
  // 应用的元数据数组。
  apps: AppMetadata[],
  // 预加载策略，可以是布尔值、字符串数组或函数。
  prefetchStrategy: PrefetchStrategy,
  // 可选的导入条目选项。
  importEntryOpts?: ImportEntryOpts,
) {
  const appsName2Apps = (names: string[]): AppMetadata[] => apps.filter((app) => names.includes(app.name));

  if (Array.isArray(prefetchStrategy)) {
    prefetchAfterFirstMounted(appsName2Apps(prefetchStrategy as string[]), importEntryOpts);
  } else if (isFunction(prefetchStrategy)) {
    (async () => {
      // critical rendering apps would be prefetch as earlier as possible
      const { criticalAppNames = [], minorAppsName = [] } = await prefetchStrategy(apps);
      prefetchImmediately(appsName2Apps(criticalAppNames), importEntryOpts);
      prefetchAfterFirstMounted(appsName2Apps(minorAppsName), importEntryOpts);
    })();
  } else {
    switch (prefetchStrategy) {
      case true:
        prefetchAfterFirstMounted(apps, importEntryOpts);
        break;

      case 'all':
        prefetchImmediately(apps, importEntryOpts);
        break;

      default:
        break;
    }
  }
}
