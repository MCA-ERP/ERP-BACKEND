export class Logger {
  private context: string;

  constructor(context: string = "ERP-Backend") {
    this.context = context;
  }

  log(message: string, ...args: any[]): void {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] [LOG] [${this.context}] ${message}`, ...args);
  }

  error(message: string, trace?: string): void {
    const timestamp = new Date().toISOString();
    console.error(`[${timestamp}] [ERROR] [${this.context}] ${message}`);
    if (trace) console.error(trace);
  }

  warn(message: string, ...args: any[]): void {
    const timestamp = new Date().toISOString();
    console.warn(`[${timestamp}] [WARN] [${this.context}] ${message}`, ...args);
  }
}
