/**
 * @description: 继承了普通的 Error 对象,多了一段 [qiankun]: 作为前缀
 */
export class QiankunError extends Error {
  constructor(message: string) {
    super(`[qiankun]: ${message}`);
  }
}
