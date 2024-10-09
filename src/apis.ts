import { noop } from 'lodash';
import type { ParcelConfigObject } from 'single-spa';
import { mountRootParcel, registerApplication, start as startSingleSpa } from 'single-spa';
import type {
  FrameworkConfiguration,
  FrameworkLifeCycles,
  LoadableApp,
  MicroApp,
  ObjectType,
  RegistrableApp,
} from './interfaces';
import type { ParcelConfigObjectGetter } from './loader';
import { loadApp } from './loader';
import { doPrefetchStrategy } from './prefetch';
import { Deferred, getContainerXPath, isConstDestructAssignmentSupported, toArray } from './utils';

// 存储已注册的微应用
let microApps: Array<RegistrableApp<Record<string, unknown>>> = [];
// 存储框架配置
export let frameworkConfiguration: FrameworkConfiguration = {};
// 标志框架是否已启动
// 执行 single-spa 的 start 后设置为 true
let started = false;
// 默认的 URL 重路由配置
const defaultUrlRerouteOnly = true;
// 用于延迟框架启动的 Deferred 对象
const frameworkStartedDefer = new Deferred<void>();
// 使用 appConfigPromiseGetterMap 缓存微应用配置，以便在重新挂载时提高性能。
const appConfigPromiseGetterMap = new Map<string, Promise<ParcelConfigObjectGetter>>();
// 变量用于管理挂载在相同容器上的微应用实例。它的作用是确保在同一个容器中挂载多个微应用时，能够正确处理这些微应用的生命周期，避免并发问题。
// 具体来说，当多个微应用挂载在同一个容器时，containerMicroAppsMap 会记录这些微应用的实例，并在重新挂载时确保之前的实例已经卸载完毕，从而避免并发问题。
const containerMicroAppsMap = new Map<string, MicroApp[]>();

/**
 * 降级处理函数：
 * 用于处理低版本浏览器的兼容性问题，特别是那些不支持 Proxy 对象的浏览器。它会根据浏览器的特性自动调整 qiankun 框架的配置，以确保在这些环境下能够正常运行。
 */
const autoDowngradeForLowVersionBrowser = (configuration: FrameworkConfiguration): FrameworkConfiguration => {
  const { sandbox = true, singular } = configuration;

  // 检查浏览器是否支持 Proxy 对象
  if (sandbox) {
    if (!window.Proxy) {
      console.warn('[qiankun] Missing window.Proxy, proxySandbox will degenerate into snapshotSandbox');

      // 如果 singular 配置为 false，给出警告
      if (singular === false) {
        console.warn(
          '[qiankun] Setting singular as false may cause unexpected behavior while your browser not support window.Proxy',
        );
      }

      // 返回降级后的配置，将 sandbox 配置为 snapshotSandbox
      return { ...configuration, sandbox: typeof sandbox === 'object' ? { ...sandbox, loose: true } : { loose: true } };
    }

    // 检查是否支持常量解构赋值
    if (
      !isConstDestructAssignmentSupported() &&
      (sandbox === true || (typeof sandbox === 'object' && sandbox.speedy !== false))
    ) {
      console.warn(
        '[qiankun] Speedy mode will turn off as const destruct assignment not supported in current browser!',
      );

      return {
        ...configuration,
        sandbox: typeof sandbox === 'object' ? { ...sandbox, speedy: false } : { speedy: false },
      };
    }
  }

  return configuration;
};

/**
 * https://qiankun.umijs.org/zh/api#registermicroappsapps-lifecycles
 * 注册子应用，并且在子应用激活时，创建运行沙箱
 * 写法如下:
// 注册子应用
registerMicroApps([
  {
    name: 'reactApp',
    entry: '//localhost:7100',
    container: '#container',
    activeRule: '/react',
  },
  {
    name: 'vueApp',
    entry: '//localhost:7200',
    container: '#container',
    activeRule: '/vue',
  },
]);
// 启动
start();
 */
export function registerMicroApps<T extends ObjectType>(
  // 必选，微应用的一些注册信息
  apps: Array<RegistrableApp<T>>,
  // 可选，全局的微应用生命周期钩子
  lifeCycles?: FrameworkLifeCycles<T>,
) {
  // Each app only needs to be registered once
  const unregisteredApps = apps.filter((app) => !microApps.some((registeredApp) => registeredApp.name === app.name));

  microApps = [...microApps, ...unregisteredApps];

  unregisteredApps.forEach((app) => {
    const {
      // 必选，微应用的名称，微应用之间必须确保唯一。
      name,
      // 必选，微应用的激活规则。
      activeRule,
      // 可选，loading 状态发生变化时会调用的方法。
      loader = noop,
      // 可选，主应用需要传递给微应用的数据。
      props,
      // container - string | HTMLElement - 必选，微应用的容器节点的选择器或者 Element 实例。如container: '#root' 或 container: document.querySelector('#root')。
      // entry - string | { scripts?: string[]; styles?: string[]; html?: string } - 必选，微应用的入口。
      ...appConfig
    } = app;

    // 调用了 single-spa 的 registerApplication 方法注册了子应用。
    registerApplication({
      // 标识应用程序。
      name,
      // 定义应用程序实例及其生命周期方法。
      app: async () => {
        // 加载中
        loader(true);
        // 等待主应用加载完成
        await frameworkStartedDefer.promise;

        const { mount, ...otherMicroAppConfigs } = (
          await loadApp({ name, props, ...appConfig }, frameworkConfiguration, lifeCycles)
        )();

        return {
          // 此处 loader 的执行是为了后续卸载后重新加载时，能够再次触发 loader 方法
          mount: [async () => loader(true), ...toArray(mount), async () => loader(false)],
          ...otherMicroAppConfigs,
        };
      },
      // 定义应用程序何时处于活动状态。
      activeWhen: activeRule,
      // props（主应用需要传递给子应用的数据）
      customProps: props,
    });
  });
}

/**
 * 其他逻辑:
 * 缓存
 * 生命周期函数的覆盖
 * 重新启动single spa
 *
 * 如果微应用不是直接跟路由关联的时候，你也可以选择手动加载微应用的方式：
loadMicroApp({
  name: 'app',
  entry: '//localhost:7100',
  container: '#yourContainer',
});
 */
export function loadMicroApp<T extends ObjectType>(
  app: LoadableApp<T>,
  configuration?: FrameworkConfiguration & { autoStart?: boolean },
  lifeCycles?: FrameworkLifeCycles<T>,
): MicroApp {
  const { props, name } = app;

  const container = 'container' in app ? app.container : undefined;
  // 计算容器的 XPath 以确保在重新挂载时使用相同的容器
  // 形如 "/*[name()='HTML']/*[name()='BODY'][1]/*[name()='DIV'][1]/*[name()='DIV'][1]/*[name()='DIV'][3]/*[name()='DIV'][1]/*[name()='H3'][2]"
  // 必须在开始时计算容器 xpath，以使其与应用程序运行保持一致 如果我们每次都计算它，容器 dom 结构很可能会被更改并导致不同的 xpath 值
  const containerXPath = getContainerXPath(container);
  // appContainerXPathKey是缓存的key
  const appContainerXPathKey = `${name}-${containerXPath}`;

  let microApp: MicroApp;

  /**
   * 用于包装微应用配置
   * 定义了一个空的 bootstrap 钩子覆盖之前的配置，以确保缓存过的不重新执行
   * 定义了一个 mount 钩子, 用于确保在同一个容器上挂载多个微应用时，能够正确处理这些微应用的生命周期，避免并发问题
   */
  const wrapParcelConfigForRemount = (config: ParcelConfigObject): ParcelConfigObject => {
    let microAppConfig = config;
    if (container) {
      if (containerXPath) {
        const containerMicroApps = containerMicroAppsMap.get(appContainerXPathKey);
        if (containerMicroApps?.length) {
          const mount = [
            async () => {
              // While there are multiple micro apps mounted on the same container, we must wait until the prev instances all had unmounted
              // Otherwise it will lead some concurrent issues
              const prevLoadMicroApps = containerMicroApps.slice(0, containerMicroApps.indexOf(microApp));
              const prevLoadMicroAppsWhichNotBroken = prevLoadMicroApps.filter(
                (v) => v.getStatus() !== 'LOAD_ERROR' && v.getStatus() !== 'SKIP_BECAUSE_BROKEN',
              );
              await Promise.all(prevLoadMicroAppsWhichNotBroken.map((v) => v.unmountPromise));
            },
            ...toArray(microAppConfig.mount),
          ];

          microAppConfig = {
            ...config,
            mount,
          };
        }
      }
    }

    return {
      ...microAppConfig,
      // empty bootstrap hook which should not run twice while it calling from cached micro app
      bootstrap: () => Promise.resolve(),
    };
  };

  /**
   * using name + container xpath as the micro app instance id,
   * it means if you rendering a micro app to a dom which have been rendered before,
   * the micro app would not load and evaluate its lifecycles again
   * 将 loadApp 的返回值缓存到 appConfigPromiseGetterMap 中,缓存key是 $$cacheLifecycleByAppName ? name : appContainerXPathKey
   * 重新加载的时候直接从缓存中取值,不会执行生命周期方法了
   */
  const memorizedLoadingFn = async (): Promise<ParcelConfigObject> => {
    const userConfiguration = autoDowngradeForLowVersionBrowser(
      configuration ?? { ...frameworkConfiguration, singular: false },
    );
    const { $$cacheLifecycleByAppName } = userConfiguration;

    if (container) {
      // using appName as cache for internal experimental scenario
      if ($$cacheLifecycleByAppName) {
        const parcelConfigGetterPromise = appConfigPromiseGetterMap.get(name);
        if (parcelConfigGetterPromise) return wrapParcelConfigForRemount((await parcelConfigGetterPromise)(container));
      }

      if (containerXPath) {
        const parcelConfigGetterPromise = appConfigPromiseGetterMap.get(appContainerXPathKey);
        if (parcelConfigGetterPromise) return wrapParcelConfigForRemount((await parcelConfigGetterPromise)(container));
      }
    }

    const parcelConfigObjectGetterPromise = loadApp(app, userConfiguration, lifeCycles);

    if (container) {
      if ($$cacheLifecycleByAppName) {
        appConfigPromiseGetterMap.set(name, parcelConfigObjectGetterPromise);

        // 此处将 loadApp 的返回值缓存到 appConfigPromiseGetterMap 中，以便在重新挂载时使用。
      } else if (containerXPath) appConfigPromiseGetterMap.set(appContainerXPathKey, parcelConfigObjectGetterPromise);
    }

    return (await parcelConfigObjectGetterPromise)(container);
  };

  // 如果尚未启动，并且配置中 autoStart 不为 false，则启动 single-spa。
  if (!started && configuration?.autoStart !== false) {
    // We need to invoke start method of single-spa as the popstate event should be dispatched while the main app calling pushState/replaceState automatically,
    // but in single-spa it will check the start status before it dispatch popstate
    // see https://github.com/single-spa/single-spa/blob/f28b5963be1484583a072c8145ac0b5a28d91235/src/navigation/navigation-events.js#L101
    // ref https://github.com/umijs/qiankun/pull/1071
    // 当主应用程序调用 pushState 或 replaceState 方法时，应该自动触发 popstate 事件。
    // 然而，在 single-spa 框架中，popstate 事件的触发是有条件的，即它会先检查 single-spa 是否已经启动（通过调用 start 方法）。
    startSingleSpa({ urlRerouteOnly: frameworkConfiguration.urlRerouteOnly ?? defaultUrlRerouteOnly });
  }

  // 使用 single-spa 的 mountRootParcel 挂载微应用，并将其存储在 containerMicroAppsMap 中
  microApp = mountRootParcel(memorizedLoadingFn, { domElement: document.createElement('div'), ...props });

  if (container) {
    if (containerXPath) {
      // Store the microApps which they mounted on the same container
      const microAppsRef = containerMicroAppsMap.get(appContainerXPathKey) || [];
      microAppsRef.push(microApp);
      containerMicroAppsMap.set(appContainerXPathKey, microAppsRef);

      const cleanup = () => {
        const index = microAppsRef.indexOf(microApp);
        microAppsRef.splice(index, 1);
        // @ts-ignore
        microApp = null;
      };

      // gc after unmount
      microApp.unmountPromise.then(cleanup).catch(cleanup);
    }
  }

  return microApp;
}

export function start(opts: FrameworkConfiguration = {}) {
  frameworkConfiguration = {
    // 预加载 支持配置 boolean 'all' string[] 或者函数
    prefetch: true,
    // 在单一模式下，任何应用程序都将等待加载，直到其他应用程序取消挂载
    // 对于一次只显示一个子应用的场景很有用
    singular: true,
    // 沙箱模式 支持配置 boolean 和对象
    sandbox: true,
    ...opts,
  };
  const {
    prefetch,
    // 是 StartOpts 唯一的配置项
    urlRerouteOnly = defaultUrlRerouteOnly,
    ...importEntryOpts
  } = frameworkConfiguration;

  if (prefetch) {
    doPrefetchStrategy(microApps, prefetch, importEntryOpts);
  }

  frameworkConfiguration = autoDowngradeForLowVersionBrowser(frameworkConfiguration);

  startSingleSpa({ urlRerouteOnly });
  started = true;

  frameworkStartedDefer.resolve();
}
