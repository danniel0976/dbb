-- Migration 012: Add theme_preference column to profiles
-- Phase 22: Light/Dark Mode + System Default

ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS theme_preference text DEFAULT 'system' CHECK (theme_preference IN ('light','dark','system'));