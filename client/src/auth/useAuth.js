import { useContext } from "react";
import { AuthContext } from "./AuthContext.js";

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === null) {
    throw new Error("useAuth() must be called inside an <AuthProvider>");
  }
  return context;
}
