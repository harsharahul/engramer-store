import type { ReactNode } from "react";
import { ChevronRight, ChevronsUpDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
} from "@/components/ui/sidebar";
import { BrandMark, Wordmark } from "../FileArt";

/** One place in the sidebar: Files, Recent, Photos… */
export interface SidebarPlace {
  key: string;
  label: string;
  icon: ReactNode;
  active: boolean;
  count?: number;
  onSelect: () => void;
  /** Drop target props (the Files place takes dropped files). */
  drop?: { props: Record<string, unknown>; dropping: boolean };
}

/** A row inside a group: an album or a library category. */
export interface SidebarRow {
  key: string;
  label: string;
  icon: ReactNode;
  active: boolean;
  count?: number;
  pinned?: boolean;
  /** Briefly highlighted after it was created or added to. */
  reveal?: boolean;
  onSelect: () => void;
  onContextMenu?: (event: React.MouseEvent) => void;
  /** Extra attributes, e.g. data-album for scroll-into-view. */
  attrs?: Record<string, string>;
}

export interface SidebarGroupData {
  key: string;
  label: string;
  icon: ReactNode;
  open: boolean;
  onToggle: () => void;
  rows: SidebarRow[];
}

export interface AppSidebarProps {
  /** Icon-only rail (the layout engine decides; a hovered rail shows words). */
  collapsed: boolean;
  places: SidebarPlace[];
  groups: SidebarGroupData[];
  usage?: { label: string; percent: number };
  version: string;
  account: { email: string; onOpen: (event: React.MouseEvent<HTMLButtonElement>) => void };
}

/**
 * The sidebar's contents, drawn with shadcn/ui's sidebar parts. The layout
 * engine (frame grid, rail, hover overlay, phone drawer, divider) stays in
 * charge of where the sidebar is and how wide; this component only draws
 * what is inside it. `collapsed` switches shadcn's icon mode, which is what
 * centres every icon on one line in the rail and turns labels into tooltips.
 */
export function AppSidebar(props: AppSidebarProps) {
  const { collapsed } = props;
  const name = props.account.email.split("@")[0] ?? props.account.email;

  return (
    <SidebarProvider
      open={!collapsed}
      onOpenChange={() => {}}
      keyboardShortcut={false}
      persistCookie={false}
      className="tw:h-full tw:min-h-0 tw:flex-col"
    >
      <div
        className="tw:group tw:flex tw:h-full tw:min-h-0 tw:w-full tw:flex-col tw:text-sidebar-foreground"
        data-state={collapsed ? "collapsed" : "expanded"}
        data-collapsible={collapsed ? "icon" : ""}
        data-slot="sidebar"
      >
        <SidebarHeader className="tw:p-2 tw:pb-1 tw:group-data-[collapsible=icon]:items-center">
          {/* The brand row also drags the window in the Mac shell. */}
          <div
            className="brand tw:flex tw:h-10 tw:items-center tw:gap-2.5 tw:px-2 tw:group-data-[collapsible=icon]:justify-center tw:group-data-[collapsible=icon]:px-0"
            data-tauri-drag-region
          >
            <BrandMark size={26} />
            <span className="tw:group-data-[collapsible=icon]:hidden">
              <Wordmark />
            </span>
          </div>
        </SidebarHeader>

        <SidebarContent className="tw:gap-0 tw:overflow-y-auto">
          <SidebarGroup className="tw:py-1">
            <SidebarMenu className="tw:gap-0.5 tw:group-data-[collapsible=icon]:items-center">
              {props.places.map((place) => (
                <SidebarMenuItem key={place.key}>
                  <SidebarMenuButton
                    isActive={place.active}
                    tooltip={place.label}
                    onClick={place.onSelect}
                    className={cn(
                      "nav-item tw:h-9 tw:text-[13.5px] tw:font-medium tw:data-active:bg-primary/15 tw:data-active:text-primary",
                      place.drop?.dropping && "tw:ring-2 tw:ring-primary",
                    )}
                    {...(place.drop?.props ?? {})}
                  >
                    {place.icon}
                    <span>{place.label}</span>
                  </SidebarMenuButton>
                  {place.count !== undefined && place.count > 0 && (
                    <SidebarMenuBadge className="tw:top-2">{place.count}</SidebarMenuBadge>
                  )}
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroup>

          {props.groups.map((group) => (
            <Collapsible
              key={group.key}
              open={group.open}
              onOpenChange={() => group.onToggle()}
              className="tw:group/collapsible"
            >
              <SidebarGroup className="tw:py-1" data-group={group.key}>
                <SidebarMenu className="tw:gap-0.5 tw:group-data-[collapsible=icon]:items-center">
                  <SidebarMenuItem>
                    {/* A group keeps its icon in the rail: nothing loses its footprint. */}
                    <CollapsibleTrigger
                      render={
                        <SidebarMenuButton
                          tooltip={group.label}
                          className="sidebar-label tw:h-8 tw:text-[11px] tw:font-semibold tw:uppercase tw:tracking-[0.08em] tw:text-muted-foreground"
                        />
                      }
                    >
                      {group.icon}
                      <span>{group.label}</span>
                      <ChevronRight
                        className="tw:ml-auto tw:transition-transform tw:group-data-[collapsible=icon]:hidden tw:group-data-open/collapsible:rotate-90"
                        aria-hidden="true"
                      />
                    </CollapsibleTrigger>
                    {!group.open && group.rows.length > 0 && (
                      <SidebarMenuBadge className="tw:top-1.5 tw:right-7">{group.rows.length}</SidebarMenuBadge>
                    )}
                  </SidebarMenuItem>
                </SidebarMenu>
                <CollapsibleContent className="tw:group-data-[collapsible=icon]:hidden">
                  <SidebarMenu className="library-list tw:max-h-[40vh] tw:shrink-0 tw:gap-0.5 tw:overflow-y-auto">
                    {group.rows.map((row) => (
                      <SidebarMenuItem key={row.key}>
                        <SidebarMenuButton
                          isActive={row.active}
                          onClick={row.onSelect}
                          onContextMenu={row.onContextMenu}
                          data-reveal={row.reveal ? "true" : undefined}
                          className="nav-item small tw:h-8 tw:pl-3 tw:text-[13px] tw:data-active:bg-primary/15 tw:data-active:text-primary"
                          {...(row.attrs ?? {})}
                        >
                          {row.icon}
                          <span>{row.label}</span>
                        </SidebarMenuButton>
                        <SidebarMenuBadge className="tw:top-1.5">
                          {row.pinned ? <span className="tw:mr-1 tw:text-[9px] tw:uppercase">pinned</span> : null}
                          {row.count}
                        </SidebarMenuBadge>
                      </SidebarMenuItem>
                    ))}
                  </SidebarMenu>
                </CollapsibleContent>
              </SidebarGroup>
            </Collapsible>
          ))}
        </SidebarContent>

        <SidebarFooter className="tw:gap-1 tw:p-2">
          {props.usage && (
            <div className="tw:flex tw:flex-col tw:gap-1.5 tw:px-2 tw:py-2 tw:group-data-[collapsible=icon]:hidden">
              <div className="tw:flex tw:items-baseline tw:justify-between tw:text-[12.5px] tw:text-foreground">
                <span>{props.usage.label}</span>
                <span className="tw:text-[11px] tw:text-muted-foreground">{props.usage.percent}%</span>
              </div>
              <div
                className="tw:h-1 tw:overflow-hidden tw:rounded-full tw:bg-muted"
                role="meter"
                aria-label="Storage used"
                aria-valuenow={props.usage.percent}
                aria-valuemin={0}
                aria-valuemax={100}
              >
                <div className="tw:h-full tw:rounded-full tw:bg-primary" style={{ width: `${props.usage.percent}%` }} />
              </div>
              <div className="tw:text-[11px] tw:text-muted-foreground" title="The version running in this page">
                Encrypted at rest · v{props.version}
              </div>
            </div>
          )}
          <SidebarMenu className="tw:group-data-[collapsible=icon]:items-center">
            <SidebarMenuItem>
              <SidebarMenuButton
                size="lg"
                tooltip={props.account.email}
                aria-haspopup="menu"
                aria-label={`Account: ${props.account.email}`}
                onClick={props.account.onOpen}
                className="account-button tw:gap-2.5"
              >
                <span
                  className="tw:grid tw:size-8 tw:shrink-0 tw:place-items-center tw:rounded-full tw:bg-primary tw:text-[13px] tw:font-semibold tw:text-primary-foreground"
                  aria-hidden="true"
                >
                  {name.slice(0, 1).toUpperCase()}
                </span>
                {/* The chevron rides the name line, so the email below gets
                    the full width and a long address is not cut off. */}
                <span className="tw:grid tw:min-w-0 tw:flex-1 tw:text-left tw:leading-tight tw:group-data-[collapsible=icon]:hidden">
                  <span className="tw:flex tw:min-w-0 tw:items-center tw:gap-1">
                    <span className="tw:truncate tw:text-[13px] tw:font-semibold tw:text-foreground">{name}</span>
                    <ChevronsUpDown className="tw:ml-auto tw:size-3.5 tw:shrink-0 tw:text-muted-foreground" aria-hidden="true" />
                  </span>
                  <span className="account-link tw:truncate tw:text-[11px] tw:text-muted-foreground" title={props.account.email}>
                    {props.account.email}
                  </span>
                </span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarFooter>
      </div>
    </SidebarProvider>
  );
}
