import { createBrowserRouter } from "react-router-dom";
import Home from "./pages/Home";
import DiagPage from "./pages/webrtc/Diag";

const router = createBrowserRouter([
  {
    path: "/",
    element: <Home />,
  },
  {
    path: "/webrtc/diag",
    element: <DiagPage />,
  },
]);

export default router;
