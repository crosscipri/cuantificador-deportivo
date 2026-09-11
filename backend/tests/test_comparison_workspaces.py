import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from bson import ObjectId
from fastapi import HTTPException
from pydantic import ValidationError

from comparisons.models import ComparisonWorkspaceInput, Selection, WorkspaceChartInput
from comparisons.router import create_workspace, save_workspace_chart, workspace


class ComparisonWorkspaceTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.workspace_id = ObjectId()
        self.collection = SimpleNamespace(
            insert_one=AsyncMock(return_value=SimpleNamespace(inserted_id=self.workspace_id)),
            find_one=AsyncMock(return_value={"_id": self.workspace_id, "name": "Relojes", "charts": []}),
            update_one=AsyncMock(return_value=SimpleNamespace(matched_count=1)),
        )
        self.db = SimpleNamespace(comparison_workspaces=self.collection,
                                  comparisons=SimpleNamespace(find_one=AsyncMock()))
        self.request = SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(db=self.db)))
        self.selection = Selection(name="Carrera suave", mode="BENCHMARK",
                                   session_ids=[str(ObjectId()), str(ObjectId())],
                                   visualization={"chart_type": "metric"})

    async def test_create_empty_workspace_and_reopen(self):
        created = await create_workspace(self.request, ComparisonWorkspaceInput(name=" Relojes "))
        self.assertEqual(created["name"], "Relojes")
        self.assertEqual(created["charts"], [])
        self.assertEqual(created["id"], str(self.workspace_id))
        self.collection.find_one.return_value = self.collection.insert_one.call_args.args[0]
        self.assertEqual(await workspace(self.request, created["id"]), created)

    async def test_two_charts_keep_independent_calculations(self):
        stored = []
        for name in ("Carrera suave", "Series"):
            selection = self.selection.model_copy(update={"name": name})
            saved = {"id": str(ObjectId()), "result": {"configuration": selection.model_dump()}}
            with patch("comparisons.router.store_comparison", AsyncMock(return_value=saved)):
                response = await save_workspace_chart(self.request, str(self.workspace_id),
                                                     WorkspaceChartInput(selection=selection))
            update = self.collection.update_one.call_args.args[1]
            self.assertEqual(update["$push"]["charts"], response["chart"])
            stored.append(response["chart"])
        self.assertNotEqual(stored[0]["id"], stored[1]["id"])
        self.assertNotEqual(stored[0]["comparison_id"], stored[1]["comparison_id"])
        self.assertEqual([c["name"] for c in stored], ["Carrera suave", "Series"])

    async def test_edit_revises_only_the_selected_chart(self):
        chart = {"id": str(ObjectId()), "comparison_id": str(ObjectId()), "name": "Anterior"}
        self.collection.find_one.return_value["charts"] = [chart]
        parent = {"_id": ObjectId(chart["comparison_id"])}
        self.db.comparisons.find_one.return_value = parent
        saved = {"id": str(ObjectId()), "result": {}}
        with patch("comparisons.router.store_comparison", AsyncMock(return_value=saved)) as store:
            response = await save_workspace_chart(self.request, str(self.workspace_id),
                                                 WorkspaceChartInput(chart_id=chart["id"], selection=self.selection))
            store.assert_awaited_once_with(self.db, self.selection, parent)
        query, update = self.collection.update_one.call_args.args
        self.assertEqual(query["charts"]["$elemMatch"], {"id": chart["id"], "comparison_id": chart["comparison_id"]})
        self.assertEqual(update["$set"]["charts.$"]["id"], chart["id"])
        self.assertEqual(response["chart"]["comparison_id"], saved["id"])

    async def test_missing_workspace_or_foreign_chart_does_not_calculate(self):
        with patch("comparisons.router.store_comparison", AsyncMock()) as store:
            with self.assertRaises(HTTPException) as caught:
                await save_workspace_chart(self.request, str(self.workspace_id),
                                           WorkspaceChartInput(chart_id=str(ObjectId()), selection=self.selection))
            self.assertEqual(caught.exception.status_code, 404)
            self.collection.find_one.return_value = None
            with self.assertRaises(HTTPException) as caught:
                await save_workspace_chart(self.request, str(self.workspace_id), WorkspaceChartInput(selection=self.selection))
            self.assertEqual(caught.exception.status_code, 404)
            store.assert_not_awaited()

    async def test_calculation_failure_does_not_attach_a_chart(self):
        with patch("comparisons.router.store_comparison", AsyncMock(side_effect=HTTPException(422, "Sesiones incompatibles"))):
            with self.assertRaises(HTTPException):
                await save_workspace_chart(self.request, str(self.workspace_id), WorkspaceChartInput(selection=self.selection))
        self.collection.update_one.assert_not_awaited()

    async def test_concurrent_edit_reports_conflict(self):
        self.collection.update_one.return_value.matched_count = 0
        with patch("comparisons.router.store_comparison", AsyncMock(return_value={"id": str(ObjectId()), "result": {}})):
            with self.assertRaises(HTTPException) as caught:
                await save_workspace_chart(self.request, str(self.workspace_id), WorkspaceChartInput(selection=self.selection))
        self.assertEqual(caught.exception.status_code, 409)

    def test_workspace_names_and_chart_selections_are_validated(self):
        with self.assertRaises(ValidationError):
            ComparisonWorkspaceInput(name="   ")
        with self.assertRaises(ValidationError):
            WorkspaceChartInput(selection={"mode": "DIRECT", "session_ids": []})


if __name__ == "__main__":
    unittest.main()
