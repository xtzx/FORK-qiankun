/* eslint-disable no-param-reassign */
/**
 * @author Kuitos
 * @since 2019-04-11
 */

import { noop } from 'lodash';

const rawWindowInterval = window.setInterval;
const rawWindowClearInterval = window.clearInterval;

/**
 * 劫持定时器
 * 防止全局计时器泄露污染。
 * 让 global 执行 window 上的定时器,同时实现清理副作用功能
 */
export default function patch(global: Window) {
  let intervals: number[] = [];

  global.clearInterval = (intervalId: number) => {
    // 从 intervals 中移除 intervalId
    intervals = intervals.filter((id) => id !== intervalId);
    return rawWindowClearInterval.call(window, intervalId as any);
  };

  global.setInterval = (handler: CallableFunction, timeout?: number, ...args: any[]) => {
    const intervalId = rawWindowInterval(handler, timeout, ...args);
    // 将每个启用的定时器的 intervalId 都收集起来（
    intervals = [...intervals, intervalId];
    return intervalId;
  };

  /**
   * 执行 free 可以清理掉全部定时器
   */
  return function free() {
    intervals.forEach((id) => global.clearInterval(id));
    global.setInterval = rawWindowInterval;
    global.clearInterval = rawWindowClearInterval;

    return noop;
  };
}
