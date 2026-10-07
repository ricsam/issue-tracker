import { createContext, useContext, type Dispatch, type SetStateAction } from "react";
import type { Issue } from "../../shared/types";

export const IssueBreadcrumbContext = createContext<Dispatch<SetStateAction<Issue | null>>>(() => {});
export const useIssueBreadcrumb = () => useContext(IssueBreadcrumbContext);
