/**
 * @author Kuitos
 * @since 2019-04-11
 */

import { noop } from 'lodash';

const rawAddEventListener = window.addEventListener;
const rawRemoveEventListener = window.removeEventListener;

type ListenerMapObject = {
  listener: EventListenerOrEventListenerObject;
  options: AddEventListenerOptions;
  rawListener: EventListenerOrEventListenerObject;
};

// 定义了默认的事件监听选项
const DEFAULT_OPTIONS: AddEventListenerOptions = { capture: false, once: false, passive: false };

/**
 * 将传入的配置转换成标准的事件监听配置
 */
const normalizeOptions = (rawOptions?: boolean | AddEventListenerOptions): AddEventListenerOptions => {
  if (typeof rawOptions === 'object') {
    return rawOptions ?? DEFAULT_OPTIONS;
  }
  return { capture: !!rawOptions, once: false, passive: false };
};

const findListenerIndex = (
  listeners: ListenerMapObject[],
  rawListener: EventListenerOrEventListenerObject,
  options: AddEventListenerOptions,
): number =>
  listeners.findIndex((item) => item.rawListener === rawListener && item.options.capture === options.capture);

const removeCacheListener = (
  listenerMap: Map<string, ListenerMapObject[]>,
  type: string,
  rawListener: EventListenerOrEventListenerObject,
  rawOptions?: boolean | AddEventListenerOptions,
): ListenerMapObject => {
  const options = normalizeOptions(rawOptions);
  const cachedTypeListeners = listenerMap.get(type) || [];

  const findIndex = findListenerIndex(cachedTypeListeners, rawListener, options);
  if (findIndex > -1) {
    return cachedTypeListeners.splice(findIndex, 1)[0];
  }

  return { listener: rawListener, rawListener, options };
};

const addCacheListener = (
  listenerMap: Map<string, ListenerMapObject[]>,
  type: string,
  rawListener: EventListenerOrEventListenerObject,
  rawOptions?: boolean | AddEventListenerOptions,
): ListenerMapObject | undefined => {
  const options = normalizeOptions(rawOptions);
  const cachedTypeListeners = listenerMap.get(type) || [];

  const findIndex = findListenerIndex(cachedTypeListeners, rawListener, options);
  // avoid duplicated listener in the listener list
  if (findIndex > -1) return;

  let listener: EventListenerOrEventListenerObject = rawListener;
  if (options.once) {
    listener = (event: Event) => {
      (rawListener as EventListener)(event);
      removeCacheListener(listenerMap, type, rawListener, options);
    };
  }

  const cacheListener = { listener, options, rawListener };
  listenerMap.set(type, [...cachedTypeListeners, cacheListener]);
  return cacheListener;
};

/**
 * 劫持 window 对象上的 addEventListener 和 removeEventListener 方法
 * 支持配置 once 参数
 * 如果重复执行了 addListener 会忽略
 */
export default function patch(global: WindowProxy) {
  // 存储全部事件处理函数 包括 listener、options 和 rawListener。
  // 事件类型: [ListenerMapObject, ListenerMapObject, ListenerMapObject]
  const listenerMap = new Map<string, ListenerMapObject[]>();

  global.addEventListener = (
    type: string,
    rawListener: EventListenerOrEventListenerObject,
    rawOptions?: boolean | AddEventListenerOptions,
  ) => {
    const addListener = addCacheListener(listenerMap, type, rawListener, rawOptions);

    if (!addListener) return;
    return rawAddEventListener.call(global, type, addListener.listener, addListener.options);
  };

  global.removeEventListener = (
    type: string,
    rawListener: EventListenerOrEventListenerObject,
    rawOptions?: boolean | AddEventListenerOptions,
  ) => {
    const { listener, options } = removeCacheListener(listenerMap, type, rawListener, rawOptions);
    return rawRemoveEventListener.call(global, type, listener, options);
  };

  return function free() {
    listenerMap.forEach((listeners, type) => {
      listeners.forEach(({ rawListener, options }) => {
        global.removeEventListener(type, rawListener, options);
      });
    });
    listenerMap.clear();
    global.addEventListener = rawAddEventListener;
    global.removeEventListener = rawRemoveEventListener;
    return noop;
  };
}
