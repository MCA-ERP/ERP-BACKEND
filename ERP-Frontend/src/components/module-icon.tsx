"use client";

import React from "react";
import {
  Users,
  Network,
  Building2,
  GraduationCap,
  UserCheck,
  CreditCard,
  Bus,
  Utensils,
  Boxes,
  BookOpen,
  Bed,
  ShieldCheck,
  MessageSquare,
  Box,
} from "lucide-react";

interface ModuleIconProps {
  name: string;
  className?: string;
  size?: number;
}

export function ModuleIcon({ name, className = "w-6 h-6", size = 24 }: ModuleIconProps) {
  switch (name) {
    case "users":
      return <Users className={className} size={size} />;
    case "sitemap":
      return <Network className={className} size={size} />;
    case "building-2":
      return <Building2 className={className} size={size} />;
    case "graduation-cap":
      return <GraduationCap className={className} size={size} />;
    case "user-check":
      return <UserCheck className={className} size={size} />;
    case "credit-card":
      return <CreditCard className={className} size={size} />;
    case "bus":
      return <Bus className={className} size={size} />;
    case "utensils":
      return <Utensils className={className} size={size} />;
    case "boxes":
      return <Boxes className={className} size={size} />;
    case "book-open":
      return <BookOpen className={className} size={size} />;
    case "bed":
      return <Bed className={className} size={size} />;
    case "shield-check":
      return <ShieldCheck className={className} size={size} />;
    case "message-square":
      return <MessageSquare className={className} size={size} />;
    default:
      return <Box className={className} size={size} />;
  }
}
