# import asyncio
# from functools import partial
# from typing import Optional

# from mcp.server.fastmcp import FastMCP
# from mcp.server.transport_security import TransportSecuritySettings

# from app.routes_tables import list_tables, get_table_slice
# from app.retrieval import get_highlight, resolve_dataset_context, smart_query

# mcp = FastMCP(
#     "TabulaRAG",
#     stateless_http=True,
#     transport_security=TransportSecuritySettings(
#         enable_dns_rebinding_protection=False
#     )
# )

# @mcp.tool()
# async def ping() -> dict:
#     """Check connectivity."""
#     return {"status": "ok"}

# @mcp.tool()
# async def mcp_list_tables() -> list:
#     """List all ingested tables. Always call this first to get a valid dataset_id."""
#     loop = asyncio.get_event_loop()
#     return await loop.run_in_executor(None, list_tables)

# @mcp.tool()
# async def mcp_get_table_slice(dataset_id: int, offset: int = 0, limit: int = 30) -> dict:
#     """Get a slice of rows from a table by dataset_id."""
#     loop = asyncio.get_event_loop()
#     return await loop.run_in_executor(None, partial(get_table_slice, dataset_id, offset, limit))

# @mcp.tool()
# async def mcp_query(
#     question: str,
#     dataset_id: Optional[int] = None,
#     dataset_name: Optional[str] = None,
#     top_k: int = 10,
# ) -> dict:
#     """Answer natural-language table questions and use payload['final_response'] verbatim for end-user output."""
#     loop = asyncio.get_event_loop()

#     def _run():
#         resolved_dataset_id, resolved_dataset, resolution_note = resolve_dataset_context(
#             dataset_id=dataset_id,
#             dataset_name=dataset_name,
#             question=question,
#         )
#         payload = smart_query(
#             dataset_id=resolved_dataset_id,
#             question=question,
#             top_k=top_k,
#         )
#         payload["resolved_dataset"] = resolved_dataset
#         if resolution_note:
#             payload["resolution_note"] = resolution_note
#         return payload

#     return await loop.run_in_executor(None, _run)

# @mcp.tool()
# async def mcp_get_highlight(highlight_id: str) -> dict:
#     """Get a specific highlighted cell by its highlight ID."""
#     loop = asyncio.get_event_