import axios from "axios";

export const api = axios.create({ baseURL: "/api/v1" });

api.interceptors.request.use((c) => {
  const t = localStorage.getItem("token");
  if (t) c.headers.Authorization = "Bearer " + t;
  return c;
});

// An expired or invalid login sends the user back to the sign-in screen
api.interceptors.response.use(
  (r) => r,
  (e) => {
    if (axios.isAxiosError(e) && e.response?.status === 401 && !String(e.config?.url).includes("/auth/login")) {
      localStorage.removeItem("token");
      localStorage.removeItem("user");
      window.location.reload();
    }
    return Promise.reject(e);
  }
);

export const money = (minor: number) =>
  (minor < 0 ? "-" : "") + "$" +
  (Math.abs(minor) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export const errText = (e: unknown): string =>
  axios.isAxiosError(e) ? (e.response?.data?.error ?? e.message) : "Something went wrong";