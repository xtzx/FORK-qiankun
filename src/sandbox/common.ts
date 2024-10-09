/**
 * @author Kuitos
 * @since 2020-04-13
 */

import { isBoundedFunction, isCallable, isConstructable } from '../utils';

type AppInstance = { name: string; window: WindowProxy };
let currentRunningApp: AppInstance | null = null;

/**
 * get the app that running tasks at current tick
 */
export function getCurrentRunningApp() {
  return currentRunningApp;
}

export function setCurrentRunningApp(appInstance: { name: string; window: WindowProxy }) {
  // Set currentRunningApp and it's proxySandbox to global window, as its only use case is for document.createElement from now on, which hijacked by a global way
  currentRunningApp = appInstance;
}

export function clearCurrentRunningApp() {
  currentRunningApp = null;
}

const functionBoundedValueMap = new WeakMap<CallableFunction, CallableFunction>();

/**
 * 将一个函数重新绑定到指定的目标对象上，并返回一个新的绑定函数。
 * 这个方法特别适用于那些在微应用中调用时可能会抛出非法调用异常（Illegal invocation）的函数对象，例如 window.console 和 window.atob。
 */
export function rebindTarget2Fn(target: any, fn: any): any {
  /*
    检查传入的函数是否是可调用的（isCallable）、不是已经绑定的函数（isBoundedFunction）、并且不是可构造的函数（isConstructable）。
    如 window.console、window.atob 这类，不然微应用中调用时会抛出 Illegal invocation 异常
    目前没有完美的检测方式，这里通过 prototype 中是否还有可枚举的拓展方法的方式来判断
    @warning 这里不要随意替换成别的判断方式，因为可能触发一些 edge case（比如在 lodash.isFunction 在 iframe 上下文中可能由于调用了 top window 对象触发的安全异常）
   */
  if (isCallable(fn) && !isBoundedFunction(fn) && !isConstructable(fn)) {
    const cachedBoundFunction = functionBoundedValueMap.get(fn);
    // 如果满足上述条件，则尝试从缓存中获取已经绑定的函数，如果存在则直接返回。
    if (cachedBoundFunction) {
      return cachedBoundFunction;
    }

    // 如果缓存中不存在，则使用 Function.prototype.bind 方法将函数绑定到指定的目标对象上。
    const boundValue = Function.prototype.bind.call(fn, target);

    // 复制原函数的自定义属性到绑定后的函数上，以确保绑定后的函数具有与原函数相同的属性。
    // 比如 moment function.
    Object.getOwnPropertyNames(fn).forEach((key) => {
      // boundValue might be a proxy, we need to check the key whether exist in it
      if (!boundValue.hasOwnProperty(key)) {
        Object.defineProperty(boundValue, key, Object.getOwnPropertyDescriptor(fn, key)!);
      }
    });

    // 如果原函数具有 prototype 属性，而绑定后的函数没有，则手动复制 prototype 属性。
    if (fn.hasOwnProperty('prototype') && !boundValue.hasOwnProperty('prototype')) {
      // 不应该使用赋值运算符来设置像“boundValue.prototype = fn.prototype”这样的boundValue原型
      // 因为赋值也会查找原型链，但它没有自己的原型属性，
      // 当查找成功时，如果描述符配置为 writable false 或只有 getter 访问器，则赋值将抛出 TypeError，例如“无法分配给函数的只读属性‘prototype’”
      // see https://github.com/umijs/qiankun/issues/1121
      Object.defineProperty(boundValue, 'prototype', { value: fn.prototype, enumerable: false, writable: true });
    }

    // 处理 toString 方法，以确保绑定后的函数的 toString 方法返回与原函数一致的结果。
    // 一些 util，例如 `function isNative() { return typeof Ctor === 'function' && /native code/.test(Ctor.toString()) }` 依赖于原始的 `toString()` 结果
    // 但 bound functions 将始终为 `toString` 返回“function() {[native code]}”，这是误导性的
    if (typeof fn.toString === 'function') {
      const valueHasInstanceToString = fn.hasOwnProperty('toString') && !boundValue.hasOwnProperty('toString');
      const boundValueHasPrototypeToString = boundValue.toString === Function.prototype.toString;

      if (valueHasInstanceToString || boundValueHasPrototypeToString) {
        const originToStringDescriptor = Object.getOwnPropertyDescriptor(
          valueHasInstanceToString ? fn : Function.prototype,
          'toString',
        );

        Object.defineProperty(
          boundValue,
          'toString',
          Object.assign(
            {},
            originToStringDescriptor,
            originToStringDescriptor?.get ? null : { value: () => fn.toString() },
          ),
        );
      }
    }

    // 将绑定后的函数存入缓存，并返回该绑定后的函数。
    functionBoundedValueMap.set(fn, boundValue);
    return boundValue;
  }

  return fn;
}
