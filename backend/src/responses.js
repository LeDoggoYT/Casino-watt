export function ok(res, data = {}, message = "", status = 200) {
  return res.status(status).json({ success: true, data, message });
}

export function fail(res, status, message, data = {}) {
  return res.status(status).json({ success: false, data, message });
}

export class ApiError extends Error {
  constructor(status, message, data = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.data = data;
  }
}
