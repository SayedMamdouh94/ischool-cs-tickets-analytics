"use client";

import { Printer } from "lucide-react";
import { Button } from "@/components/ui/button";

export function PrintButton() {
  return (
    <Button variant="outline" size="sm" onClick={() => window.print()} data-print-hide>
      <Printer /> Print / save as PDF
    </Button>
  );
}
